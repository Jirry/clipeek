import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, nativeTheme, screen, shell, globalShortcut } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Adapter, Config, Session, SessionState, STATE_PRIORITY, SCALE_MIN, SCALE_MAX, SavedPosition } from '../shared/types';
import { loadConfig, saveConfig, sanitizeLights } from './store';
import { ClaudeCodeAdapter } from './adapters/claude';
import { installHook, FOCUS_DIR } from './hook';
import { acknowledge } from './ack';
import { pickNextJump, pickNextAny } from './jump';
import * as updater from './updater';

// userData 目录固定为小写 'clipeek',不随 productName(CliPeek)变:否则打包版 app.getName()=CliPeek 会让
// userData 目录改名,在大小写敏感文件系统上读不到旧 config(位置/缩放/改名/快捷键)。须早于任何 getPath('userData')。
app.setPath('userData', join(app.getPath('appData'), 'clipeek'));

/** 双击灯 → 打开/聚焦对应终端 tab。读 hook 记下的聚焦深链(目前 Warp 的 WARP_FOCUS_URL)。 */
const WARP_URL_RE = /^warp[a-z]*:\/\//i; // 仅放行 warp:// / warposs:// 深链
/** 取会话的终端聚焦深链:① hook 记的 focus 文件(精确)→ ② 用进程 PID 读环境 WARP_FOCUS_URL(兜底,覆盖装 hook 前就在跑的会话)。 */
function focusUrlFor(sessionId: string): string | null {
  try {
    const url = readFileSync(join(FOCUS_DIR, sessionId), 'utf8').trim(); // ②的精确版:hook 写的
    if (WARP_URL_RE.test(url)) return url;
  } catch {
    /* 无 focus 文件 → 走 ① */
  }
  const pid = latest.find((s) => s.id === sessionId)?.pid;
  if (pid) {
    try {
      const out = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/WARP_FOCUS_URL=(\S+)/); // ps eww 把环境追加在 CMD 列
      if (m && WARP_URL_RE.test(m[1])) return m[1];
    } catch {
      /* ps 失败 → 放弃 */
    }
  }
  return null;
}
function openTerminal(sessionId: string): void {
  acknowledge(sessionId); // 打开 tab = 已知晓 → 停止该会话绿闪(下次 poll 生效)
  const url = focusUrlFor(sessionId);
  if (url) shell.openExternal(url).catch((e) => console.error('[clipeek] openExternal fail', e));
}

// —— 全局快捷键:跳到下一个会话、聚焦其终端、并高亮该灯 ——
//  ⌘J  = 智能(pickNextJump,已单测):优先 红▸黄闪▸黄▸绿闪 循环,这些都没有才在所有绿灯里循环。
//  ⌘⇧J = 全量(pickNextAny):无视状态,在所有灯之间按顺序循环 —— 始终能切到任意一盏。
//  两者共用同一个「当前选中」游标 lastJumpId,「下一个」总从当前那盏往后走。
let lastJumpId: string | null = null; // 两个快捷键共用的「当前选中」游标
function doJump(next: Session | null): void {
  if (!next) return; // 没有可跳的灯 → 静默
  lastJumpId = next.id;
  openTerminal(next.id);
  setJumpHighlight(next.id); // 高亮被触发的灯,过会儿自动清;再按换新、旧的立即恢复
}
function jumpToNext(): void {
  doJump(pickNextJump(latest, lastJumpId)); // ⌘J
}
function jumpToNextAny(): void {
  doJump(pickNextAny(latest, lastJumpId)); // ⌘⇧J
}
// 按 config.shortcuts 注册全局键(设置里改键 → 调它重注册)。记录是否有键注册失败,供设置 UI 提示。
let shortcutConflict = false;
function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  shortcutConflict = false;
  const reg = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) shortcutConflict = true;
    } catch {
      shortcutConflict = true; // 非法 accelerator 字符串
    }
  };
  reg(config.shortcuts.jump, jumpToNext);
  reg(config.shortcuts.jumpAll, jumpToNextAny);
}

// 把「当前高亮哪个会话」下发给灯条/列表窗;HIGHLIGHT_MS 后自动清空(发 null)。
const JUMP_HIGHLIGHT_MS = 2500;
let jumpHighlightTimer: ReturnType<typeof setTimeout> | null = null;
function setJumpHighlight(id: string | null): void {
  if (jumpHighlightTimer) {
    clearTimeout(jumpHighlightTimer);
    jumpHighlightTimer = null;
  }
  barWin?.webContents.send('jump:highlight', id);
  listWin?.webContents.send('jump:highlight', id);
  if (id) jumpHighlightTimer = setTimeout(() => setJumpHighlight(null), JUMP_HIGHLIGHT_MS);
}

// 两套独立窗口,切换只是 show/hide:
//   barWin  横排窗:一排灯 + 悬停弹框(弹框内置在本窗的预留槽里)
//   listWin 竖排窗:整个竖排列表
// 所有窗口操作(resize/拖动/拉伸)都作用在「事件来源窗口」上,互不影响。
let barWin: BrowserWindow | null = null;
let listWin: BrowserWindow | null = null;
let tipWin: BrowserWindow | null = null; // 横排悬停某个灯时弹出的提示框(名字可编辑 + 路径)
let settingsWin: BrowserWindow | null = null; // 设置窗(托盘「设置…」打开)
let tray: Tray | null = null;
let config: Config = loadConfig();
let latest: Session[] = [];

const adapters: Adapter[] = [new ClaudeCodeAdapter()];
// 每个窗口各自的最小尺寸(渲染层上报):状态条和列表的最小宽高不同,不能共用一个全局值
const winMin = new Map<number, { w: number; h: number }>();
function minOf(win: BrowserWindow): { w: number; h: number } {
  return winMin.get(win.id) ?? { w: 80, h: 20 };
}
let dockBottom = true;
let dockRight = true;
// 浮层(列表/提示框)与灯条的间隙:浮层底边 = barTop + ABOVE_GAP。
// 负值 = 留可见间隙(避免两窗边框/半透明叠在一起出现重影/双线)。-1 = 1px 间隙。
const ABOVE_GAP = -1;
// 竖排列表窗的显示方式:hidden 隐藏 / above 横排时浮在状态条上方 / corner 竖排模式占屏幕角
let listMode: 'hidden' | 'corner' = 'hidden'; // 竖排列表只有「隐藏」或「竖排」(横排不再弹列表)

function activeWin(): BrowserWindow | null {
  return config.layout === 'list' ? listWin : barWin;
}
function winOf(e: Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}
// 默认位置 = 指定显示器(默认主屏)的右下角。用 bounds(含 Dock 区)→ HUD 压在 Dock 上。
function defaultPos(w: number, h: number, display?: Electron.Display) {
  const b = (display ?? screen.getPrimaryDisplay()).bounds;
  return { x: b.x + b.width - w, y: b.y + b.height - h };
}
// 恢复状态条位置:按上次贴的「角(dockRight/dockBottom)+ 屏」用当前宽高实时贴边。
// 状态条宽随会话数自适应,绝对左上角内容宽一变就偏 → 只记「贴哪条边」,落点每次现算。
// 用上次左上角定位「在哪块屏」;getDisplayNearestPoint 在那块屏被拔掉时自动回退到最近的屏。
function restoredBarPos(w: number, h: number) {
  const ref = config.x != null && config.y != null ? { x: config.x, y: config.y } : null;
  const disp = ref ? screen.getDisplayNearestPoint(ref) : screen.getPrimaryDisplay();
  const b = disp.bounds;
  return {
    x: config.dockRight ? b.x + b.width - w : b.x,
    y: config.dockBottom ? b.y + b.height - h : disp.workArea.y, // 贴顶 → 菜单栏下沿,不钻进菜单栏区
  };
}

function makeWin(role: 'bar' | 'list' | 'tip', show: boolean): BrowserWindow {
  // 状态条按「保存过的宽/高」建窗(没存过才用 320×80 占位):否则先建成占位宽、fit 时会把右/下贴边错锚到占位尺寸 → 留出缝
  const initW = role === 'bar' && config.width != null ? config.width : 320;
  const initH = role === 'bar' && config.height != null ? config.height : 80;
  const pos = role === 'bar' ? restoredBarPos(initW, initH) : defaultPos(320, 80); // 状态条恢复上次位置
  const w = new BrowserWindow({
    width: initW,
    height: initH,
    x: pos.x,
    y: pos.y,
    show,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: true,
    acceptFirstMouse: true, // 状态条是后台 HUD(非激活窗口):不加这个,右键/点击会被 macOS 当「激活点击」吞掉或透传到下层 app
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关键:窗口隐藏后 Electron 默认暂停 rAF/定时器(backgroundThrottling)。
      // 列表窗靠 rAF 测量尺寸→定位→显示,被冻结就再也弹不出来。必须关掉。
      backgroundThrottling: false,
    },
  });
  // 不用 'screen-saver':它层级 ≥ 系统截图工具的覆盖层,会把截图框选界面压在下面、挡得没法操作。
  // 'floating' 仍浮在普通 app 之上(够 HUD 用),但低于截图层 → 截图时不再挡;代价:全屏 app 里看不到。
  // 不加 setContentProtection:那会让状态条不被截图/录屏拍到,用户想正常截到它。
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.loadFile(join(__dirname, 'renderer', 'index.html'), { query: { role } });
  w.on('blur', () => {
    // 只在「正被本窗拖动/拉伸」时才停 —— 否则隐藏 tip/list 的异步 blur 会误杀其它窗的拖动
    if (w === dragWin) stopDrag();
    if (w === resizeWin) stopResize();
  });
  w.webContents.once('did-finish-load', () => {
    w.webContents.send('config', config);
    w.webContents.send('dock', dockPayload());
    w.webContents.send('sessions', namedSessions());
    // 启动即竖排时,列表加载后触发一次定位显示
    if (role === 'list' && listMode !== 'hidden') {
      w.webContents.send('list:width', barContentWidth());
    }
  });
  return w;
}

function createWindows() {
  barWin = makeWin('bar', config.layout !== 'list');
  listWin = makeWin('list', config.layout === 'list');
  tipWin = makeWin('tip', false);
  // 最小尺寸兜底(fitBar/fitList 上报前也别让窗口被拉得过小)
  winMin.set(barWin.id, { w: 160, h: 28 });
  winMin.set(listWin.id, { w: 300, h: 156 }); // fitList 上报前的兜底(默认宽 / 3 行高)
}

function dockPayload() {
  const a = activeWin();
  const pos = defaultPos(320, 80);
  const b = a ? a.getBounds() : { x: pos.x, y: pos.y, width: 320, height: 80 };
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;
  const bottomGap = d.bounds.y + d.bounds.height - (wa.y + wa.height);
  dockBottom = b.y + b.height / 2 > wa.y + wa.height / 2;
  dockRight = b.x + b.width / 2 > wa.x + wa.width / 2;
  return { bottom: dockBottom, right: dockRight, dockH: bottomGap > 20 ? bottomGap : 56, home: homedir() };
}
function pushConfig() {
  const c = config;
  barWin?.webContents.send('config', c);
  listWin?.webContents.send('config', c);
  tipWin?.webContents.send('config', c); // 提示框也要收 config,否则缩放/显名变化它不跟
  settingsWin?.webContents.send('config', c); // 设置窗也同步(托盘改了它要跟着更新)
}
function pushDock() {
  const p = dockPayload();
  barWin?.webContents.send('dock', p);
  listWin?.webContents.send('dock', p);
  tipWin?.webContents.send('dock', p);
}
function namedSessions(): Session[] {
  const ordered = [...latest].sort(
    (a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] || b.lastActivity - a.lastActivity,
  );
  return ordered.map((s) => {
    const custom = config.names[s.id];
    return custom ? { ...s, name: custom, title: custom } : s;
  });
}
function pushSessions() {
  const named = namedSessions();
  barWin?.webContents.send('sessions', named);
  listWin?.webContents.send('sessions', named);
  if (tipId !== null) {
    // 提示框开着时,把它那条会话的最新状态/名字同步过去;会话没了就收起
    const s = named.find((x) => x.id === tipId);
    if (s) tipWin?.webContents.send('tip:session', s, barContentWidth(), false, false); // 轮询:不淡入、内容没变不重渲染
    else hideTip();
  }
  updateTray(named);
}

// 浮层纵向定位:默认贴灯条上方;若上方放不下(灯条靠近屏幕顶部),改为贴灯条下方。
function popupY(b: Electron.Rectangle, h: number, area: Electron.Rectangle): number {
  const aboveY = b.y - h + ABOVE_GAP; // 朝上时浮层顶边
  const y = aboveY >= area.y ? aboveY : b.y + b.height - ABOVE_GAP; // 上方够→朝上;不够→朝下
  return Math.round(Math.min(Math.max(y, area.y), area.y + area.height - h));
}

function barContentWidth(): number {
  // 玻璃面无左右边距 → 内容宽 = 窗口宽
  const bw = barWin?.getBounds().width ?? 320;
  return Math.max(120, bw);
}
// 竖排列表只在「竖排模式」出现(横排只剩状态条,不再有弹出列表)。corner = 可自由拖动的独立窗口。
function showList() {
  listMode = 'corner';
  if (listWin) {
    // 进入竖排时把列表归到「所在显示器」的右下角并显示(多屏不跳回主屏)
    const b = listWin.getBounds();
    const { x, y } = defaultPos(b.width, b.height, screen.getDisplayMatching(b));
    listWin.setBounds({ x, y, width: b.width, height: b.height });
    if (!listWin.isVisible()) listWin.showInactive();
  }
  listWin?.webContents.send('list:width', barContentWidth()); // 触发渲染 → fit → 定位 → 显示
}
function hideList() {
  listMode = 'hidden';
  listWin?.hide();
}

// —— 悬停提示框(tipWin):横排时鼠标停在某个灯上弹出,显示该会话的名字(可编辑)+ 路径。
//    形态对齐「列表」:与灯条等宽、贴在灯条正上方(不再按单个灯定位 → 规避 Retina 坐标、滚动锚点失效、遮挡点击)。 ——
let tipId: string | null = null;
let tipEditing = false; // 提示框里正在改名 → 不因鼠标移出而隐藏
let tipHideTimer: ReturnType<typeof setTimeout> | null = null;
let tipShowTimer: ReturnType<typeof setTimeout> | null = null; // 首次弹出的悬停延迟
let pendingShowId: string | null = null;
function cancelHideTip() {
  if (tipHideTimer) {
    clearTimeout(tipHideTimer);
    tipHideTimer = null;
  }
}
function cancelShowTip() {
  if (tipShowTimer) {
    clearTimeout(tipShowTimer);
    tipShowTimer = null;
  }
  pendingShowId = null;
}
function hideTip() {
  cancelHideTip();
  cancelShowTip();
  tipId = null;
  tipEditing = false;
  tipWin?.hide();
}
function scheduleHideTip() {
  if (tipEditing) return; // 编辑中不收
  cancelHideTip();
  tipHideTimer = setTimeout(hideTip, 220); // 给「从灯条移到提示框上」留缓冲
}
// 悬停某个灯:已显示 → 立即换内容(切换跟手);从隐藏首次弹出 → 延迟 240ms(避免划过乱弹)
function requestShowTip(id: string) {
  if (config.layout !== 'bar') return; // 仅横排状态条上才弹提示框
  cancelHideTip();
  if (tipWin?.isVisible()) {
    showTipNow(id);
  } else {
    if (tipShowTimer) clearTimeout(tipShowTimer);
    pendingShowId = id;
    tipShowTimer = setTimeout(() => {
      tipShowTimer = null;
      const pid = pendingShowId;
      pendingShowId = null;
      if (pid) showTipNow(pid);
    }, 240);
  }
}
function showTipNow(id: string) {
  const s = namedSessions().find((x) => x.id === id);
  if (!s) {
    hideTip(); // 会话已不存在 → 清掉 tipId,别留残值
    return;
  }
  cancelHideTip();
  tipId = id;
  // animate 只在「从隐藏首次弹出」时为 true → 灯间切换不重放淡入(否则一闪一闪)。
  // 始终重渲染以触发显示(即便内容和上次相同,窗口可能已被隐藏过)。
  tipWin?.webContents.send('tip:session', s, barContentWidth(), !tipWin.isVisible(), true);
}
function positionTip(_w: number, h: number) {
  if (!tipWin || tipId === null || !barWin) return;
  const b = barWin.getBounds();
  const a = screen.getDisplayMatching(b).workArea; // 用 workArea:浮层不钻到菜单栏后面
  const w = b.width; // 与灯条等宽、同 x → 对齐
  const x = Math.round(Math.min(Math.max(b.x, a.x), a.x + a.width - w));
  const y = popupY(b, h, a); // 贴灯条上方;上方不够则朝下
  tipWin.setBounds({ x, y, width: w, height: Math.ceil(h) });
  if (!tipWin.isVisible()) tipWin.showInactive();
}

// 自定义快照恢复时的一次性目标坐标:等 hud 渲染回真实宽高后,由 fitWindow 精确落位(只用一次)
let restorePos: { x: number; y: number } | null = null;
// —— 窗口自适应贴合(作用于来源窗口,锚定屏幕角)——
function fitWindow(win: BrowserWindow, w: number, h: number) {
  const b = win.getBounds();
  const newW = Math.max(1, Math.ceil(w));
  const newH = Math.max(1, Math.ceil(h));
  if ((win === resizeWin && resizeAnchor) || (win === dragWin && dragAnchor)) return; // 手动拉伸/拖动时不抢
  const disp = screen.getDisplayMatching(b);
  const area = disp.bounds;
  // 自定义快照恢复:渲染后用真实宽高 + 记录坐标一次性精确落位(否则 repositionBar 用旧宽高,首次会偏、需点两次)
  if (win === barWin && restorePos) {
    const rx = Math.min(Math.max(restorePos.x, area.x), area.x + area.width - newW);
    const ry = Math.min(Math.max(restorePos.y, disp.workArea.y), area.y + area.height - newH);
    restorePos = null;
    win.setBounds({ x: Math.round(rx), y: Math.round(ry), width: newW, height: newH });
    return;
  }
  // 顶部居中预设:整屏水平居中 + 贴菜单栏下沿(优先于下面的贴角锚定)
  if (config.topCenter && win === barWin) {
    const nx = Math.round(area.x + (area.width - newW) / 2);
    const ny = disp.workArea.y;
    if (nx !== b.x || ny !== b.y || newW !== b.width || newH !== b.height) win.setBounds({ x: nx, y: ny, width: newW, height: newH });
    return;
  }
  // 只重锚「尺寸变了的那一维」:宽没变就别动 x(否则中线两侧来回切锚点会跳一两 px)
  const anchorRight = b.x + b.width / 2 > area.x + area.width / 2;
  const anchorBottom = b.y + b.height / 2 > area.y + area.height / 2;
  let nx = newW !== b.width ? (anchorRight ? b.x + b.width - newW : b.x) : b.x;
  let ny = newH !== b.height ? (anchorBottom ? b.y + b.height - newH : b.y) : b.y;
  // 夹到屏内;窗口比屏还大时上下界会反转 → 取 min/max 兜底,避免被钉死
  const loX = Math.min(area.x, area.x + area.width - newW);
  const hiX = Math.max(area.x, area.x + area.width - newW);
  const loY = Math.min(area.y, area.y + area.height - newH);
  const hiY = Math.max(area.y, area.y + area.height - newH);
  nx = Math.round(Math.min(Math.max(nx, loX), hiX));
  ny = Math.round(Math.min(Math.max(ny, loY), hiY));
  if (nx === b.x && ny === b.y && newW === b.width && newH === b.height) return;
  win.setBounds({ x: nx, y: ny, width: newW, height: newH });
}

// —— 拖动:光标轮询移动(平滑跟手)+ pointer 事件可靠起止(松手必停,不失控)——
let dragWin: BrowserWindow | null = null;
let dragTimer: ReturnType<typeof setInterval> | null = null;
let dragAnchor: { cx: number; cy: number; x: number; y: number } | null = null;
function startDrag(win: BrowserWindow | null) {
  if (!win) return;
  stopDrag();
  dragWin = win; // 先武装,再收起列表/提示框(它们的异步 blur 才不会误杀本次拖动)
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragAnchor = { cx: c.x, cy: c.y, x: b.x, y: b.y };
  if (win === barWin && tipId !== null) hideTip(); // 拖状态条前收起提示框
  dragTimer = setInterval(dragTick, 16);
}
function dragTick() {
  if (!dragWin || !dragAnchor) return;
  const c = screen.getCursorScreenPoint();
  const b = dragWin.getBounds();
  const disp = screen.getDisplayNearestPoint(c); // 夹在「光标所在那块屏」内 → 可跨屏(光标过去窗口跟过去),又进不了副屏外的空隙
  const area = disp.bounds;
  const topY = disp.workArea.y; // 上边界 = 菜单栏下沿:状态条紧贴菜单栏下方,不钻进系统菜单栏区
  const botY = area.y + area.height - b.height; // 下边界 = 屏幕底(仍可压住 Dock)
  // 窗口比屏还宽/高时上下界反转 → 用 min/max 兜底,否则被钉在边上拖不动
  const loX = Math.min(area.x, area.x + area.width - b.width);
  const hiX = Math.max(area.x, area.x + area.width - b.width);
  const loY = Math.min(topY, botY);
  const hiY = Math.max(topY, botY);
  const x = Math.min(Math.max(dragAnchor.x + (c.x - dragAnchor.cx), loX), hiX);
  const y = Math.min(Math.max(dragAnchor.y + (c.y - dragAnchor.cy), loY), hiY);
  if (Math.round(x) !== b.x || Math.round(y) !== b.y) {
    dragWin.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  }
}
function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (dragWin) {
    if (dragWin === barWin) saveBarPos(); // 记住状态条位置
    pushDock();
  }
  dragWin = null;
  dragAnchor = null;
}

// —— 拉伸:边(left/right 调宽、top 调高)+ 四角(同时调宽+调高)。光标轮询 + pointer 可靠起止 ——
// 锚定:左/右角→对侧边固定;顶角→底边固定,底角→顶边固定。
type ResizeEdge = 'left' | 'right' | 'top' | 'bottom' | 'topleft' | 'topright' | 'botleft' | 'botright';
function edgeAxes(edge: ResizeEdge): { horiz: 'left' | 'right' | null; vert: 'top' | 'bottom' | null } {
  return {
    horiz: edge.includes('left') ? 'left' : edge.includes('right') ? 'right' : null,
    vert: edge.includes('top') ? 'top' : edge.includes('bot') ? 'bottom' : null,
  };
}
let resizeWin: BrowserWindow | null = null;
let resizeTimer: ReturnType<typeof setInterval> | null = null;
let resizeAnchor: { edge: ResizeEdge; cx: number; cy: number; x: number; y: number; width: number; height: number } | null =
  null;
function startResize(win: BrowserWindow | null, edge: ResizeEdge) {
  if (!win) return;
  stopResize();
  resizeWin = win; // 先武装,再收起列表/提示框(异步 blur 才不会误杀本次拉伸)
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  resizeAnchor = { edge, cx: c.x, cy: c.y, x: b.x, y: b.y, width: b.width, height: b.height };
  if (win === barWin && tipId !== null) hideTip(); // 拉伸状态条前收起提示框
  resizeTimer = setInterval(resizeTick, 16);
}
function resizeTick() {
  if (!resizeWin || !resizeAnchor) return;
  const a = resizeAnchor;
  const c = screen.getCursorScreenPoint();
  const b = resizeWin.getBounds();
  const area = screen.getDisplayMatching(b).bounds;
  const min = minOf(resizeWin); // 各窗用自己上报的最小尺寸
  const { horiz, vert } = edgeAxes(a.edge);
  let x = b.x;
  let y = b.y;
  let w = b.width;
  let h = b.height;
  if (horiz === 'left') {
    const right = a.x + a.width; // 右边固定
    w = Math.min(Math.max(a.width - (c.x - a.cx), min.w), right - area.x);
    x = right - w;
  } else if (horiz === 'right') {
    x = a.x; // 左边固定
    w = Math.min(Math.max(a.width + (c.x - a.cx), min.w), area.x + area.width - a.x);
  }
  if (vert === 'top') {
    const bottom = a.y + a.height; // 底边固定
    h = Math.min(Math.max(a.height - (c.y - a.cy), min.h), bottom - area.y);
    y = bottom - h;
  } else if (vert === 'bottom') {
    y = a.y; // 顶边固定
    h = Math.min(Math.max(a.height + (c.y - a.cy), min.h), area.y + area.height - a.y);
  }
  x = Math.round(x);
  y = Math.round(y);
  w = Math.round(w);
  h = Math.round(h);
  if (w !== b.width || x !== b.x || h !== b.height || y !== b.y) {
    resizeWin.setBounds({ x, y, width: w, height: h });
    resizeWin.webContents.send('resizing', w, h);
  }
}
function stopResize() {
  if (resizeTimer) {
    clearInterval(resizeTimer);
    resizeTimer = null;
  }
  if (resizeWin && resizeAnchor) {
    const { horiz, vert } = edgeAxes(resizeAnchor.edge);
    const bnd = resizeWin.getBounds();
    if (resizeWin === listWin) {
      // 竖排列表:任一方向拉伸都把宽、高都存下(列表高度本是自适应,只存被拉的那维会让另一维回弹)
      config.listWidth = bnd.width;
      config.listHeight = bnd.height;
    } else {
      if (horiz) config.width = bnd.width; // 状态条:改了宽就存宽
      if (vert) config.height = bnd.height; // 高度是确定值,只存被拉的那维即可
      config.x = bnd.x; // 左缘/角拉伸会移动 x → 记住位置
      config.y = bnd.y;
      recordBarDock(bnd); // 拉伸后也更新贴角(启动按角贴边)
    }
    saveConfig(config);
    pushConfig();
  }
  resizeWin = null;
  resizeAnchor = null;
}
// 记下状态条当前贴的角:窗口中心在所在屏 workArea 的哪半边。供启动时按角贴边。
function recordBarDock(b: Electron.Rectangle) {
  const wa = screen.getDisplayMatching(b).workArea;
  config.dockRight = b.x + b.width / 2 > wa.x + wa.width / 2;
  config.dockBottom = b.y + b.height / 2 > wa.y + wa.height / 2;
}
// 记住状态条位置(供拖动结束时调用)
function saveBarPos() {
  if (!barWin) return;
  const b = barWin.getBounds();
  config.x = b.x;
  config.y = b.y;
  config.topCenter = false; // 用户一拖动就退出「顶部居中预设」,回到自由贴角
  recordBarDock(b); // 同时记住贴的是哪个角(启动按角贴边)
  saveConfig(config);
}

// —— 托盘 ——
function aggregateEmoji(s: Session[]): string {
  const live = s.filter((x) => x.state !== 'exited');
  if (live.some((x) => x.state === 'error')) return '🔴';
  if (live.some((x) => x.state === 'needsInput')) return '🔔';
  if (live.some((x) => x.state === 'working')) return '🟡';
  if (live.length) return '🟢';
  return '⚪';
}
function updateTray(s: Session[]) {
  if (!tray) return;
  const live = s.filter((x) => x.state !== 'exited').length;
  tray.setTitle(` ${aggregateEmoji(s)} ${live}`);
}
function setLayout(layout: 'bar' | 'list') {
  hideTip();
  config.layout = layout;
  saveConfig(config);
  pushConfig();
  if (layout === 'list') {
    barWin?.hide();
    showList();
  } else {
    hideList();
    barWin?.show();
  }
}
function buildMenu(): Menu {
  // 菜单只留高频的布局切换 + 设置入口 + 退出;缩放/显名/位置都进设置窗,不再重复。
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: config.layout === 'list' ? '切换横排' : '切换竖排', click: () => setLayout(config.layout === 'list' ? 'bar' : 'list') },
    { type: 'separator' },
  ];
  // 新版已下载就绪 → 顶上加一条一键重启更新。
  const u = updater.getStatus();
  if (u.phase === 'ready') {
    items.push({ label: `重启以更新到 v${u.latest}`, click: () => updater.installAndRestart() }, { type: 'separator' });
  }
  items.push(
    { label: '设置…', click: () => openSettings() },
    { label: '退出 CliPeek', click: () => app.quit() }, // 不用 role:'quit'(macOS 会给它带图标 → 整列文字右移)
  );
  return Menu.buildFromTemplate(items);
}

// —— 设置窗 ——
function openSettings(): void {
  if (process.platform === 'darwin') app.dock?.show(); // 设置窗期间进 Dock + ⌘Tab,点别处也能切回
  if (settingsWin && !settingsWin.isDestroyed()) {
    app.focus({ steal: true });
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 280,
    title: 'CliPeek 设置',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    titleBarStyle: 'hiddenInset', // 标题栏透明融入内容(交通灯浮在顶部白区,像 AirBuddy)
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2b30' : '#f4f4f7', // 内容区底色,与 --content 一致,减少首帧闪色
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(join(__dirname, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    // 默认开在偏上位置:纯居中视觉偏下,改成水平居中、垂直约 35%(在光标所在屏的工作区内)
    if (settingsWin) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const [w, h] = settingsWin.getSize();
      settingsWin.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + (area.height - h) * 0.35));
    }
    app.focus({ steal: true }); // accessory app 需主动激活,设置窗才能拿键盘(录快捷键要焦点)
    settingsWin?.show();
    settingsWin?.focus();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (process.platform === 'darwin') app.dock?.hide(); // 关掉设置窗 → 退出 Dock,回到纯菜单栏 HUD
  });
}
// 设置窗下发的整批改动:合并 → 存 → 按需触发副作用(重注册键 / 登录项 / 布局)→ 推给各窗。
function applySettings(partial: Partial<Config>): void {
  if (typeof partial.scale === 'number') {
    partial.scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, partial.scale)) * 100) / 100;
  }
  const layoutChanged = partial.layout !== undefined && partial.layout !== config.layout;
  if (partial.lights) partial.lights = sanitizeLights(partial.lights); // 落库前再夹一道(防非受控来源的越界灯效)
  Object.assign(config, partial);
  saveConfig(config);
  if (partial.shortcuts) {
    registerShortcuts();
    settingsWin?.webContents.send('settings:shortcutResult', { conflict: shortcutConflict });
  }
  if (partial.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
  if (layoutChanged) setLayout(config.layout); // 含 show/hide + save + push
  else pushConfig();
}
// —— 预设位置 + 自定义位置快照 ——
function menubarHeight(d: Electron.Display): number {
  return Math.max(0, d.workArea.y - d.bounds.y) || 24; // 菜单栏高 = 工作区顶 - 屏幕顶;拿不到兜底 24
}
// 把状态条按当前 dock/topCenter 重新摆位(用当前窗宽高粗放;渲染回来后 fitBar→fitWindow 再精确贴边/居中)。
function repositionBar(): void {
  if (!barWin) return;
  const b = barWin.getBounds();
  const d = screen.getDisplayMatching(b);
  let x: number, y: number;
  if (config.topCenter) {
    x = d.bounds.x + (d.bounds.width - b.width) / 2; // 整屏水平居中
    y = d.workArea.y; // 菜单栏下沿
  } else if (config.x != null && config.y != null) {
    // 自定义快照:回到记录的精确坐标(预设的 x/y 为 null,不走这支);夹到屏内、不钻菜单栏
    x = Math.min(Math.max(config.x, d.bounds.x), d.bounds.x + d.bounds.width - b.width);
    y = Math.min(Math.max(config.y, d.workArea.y), d.bounds.y + d.bounds.height - b.height);
  } else {
    x = config.dockRight ? d.bounds.x + d.bounds.width - b.width : d.bounds.x;
    y = config.dockBottom ? d.bounds.y + d.bounds.height - b.height : d.workArea.y;
  }
  barWin.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
}
// 预设位置:右下 / 左下 / 顶部居中。都是横排;宽=自适应(默认 6 灯 / 实际灯数),
// 高:右下/左下=Dock 高,顶部=菜单栏高。
function applyPreset(kind: 'br' | 'bl' | 'tc'): void {
  const wasList = config.layout === 'list';
  config.layout = 'bar';
  config.scale = 1; // 预设固定 100%,不沿用上一次自定义位置的缩放
  config.width = null;
  config.x = null;
  config.y = null;
  if (kind === 'tc') {
    config.topCenter = true;
    config.dockBottom = false;
    config.dockRight = false;
    config.showNames = false; // 顶部贴菜单栏,空间窄 → 不显灯下名
    const d = barWin ? screen.getDisplayMatching(barWin.getBounds()) : screen.getPrimaryDisplay();
    config.height = menubarHeight(d);
  } else {
    config.topCenter = false;
    config.dockBottom = true;
    config.dockRight = kind === 'br';
    config.showNames = true; // 右下/左下 → 显灯下名
    config.height = null; // 默认 Dock 高
  }
  saveConfig(config);
  if (wasList) setLayout('bar');
  else pushConfig();
  repositionBar();
}
// 当前配置 → 一份快照
function snapshotConfig(name: string): SavedPosition {
  return {
    name,
    layout: config.layout,
    scale: config.scale,
    showNames: config.showNames,
    x: config.x,
    y: config.y,
    width: config.width,
    height: config.height,
    listWidth: config.listWidth,
    listHeight: config.listHeight,
    dockRight: config.dockRight,
    dockBottom: config.dockBottom,
    topCenter: config.topCenter,
  };
}
function savePosition(): void {
  if (config.positions.length >= 3) return; // 最多 3 个
  config.positions.push(snapshotConfig(`位置 ${config.positions.length + 1}`));
  saveConfig(config);
  pushConfig();
}
function applyPosition(index: number): void {
  const p = config.positions[index];
  if (!p) return;
  const wasList = config.layout === 'list';
  config.layout = p.layout;
  config.scale = p.scale;
  config.showNames = p.showNames;
  config.x = p.x;
  config.y = p.y;
  config.width = p.width;
  config.height = p.height;
  config.listWidth = p.listWidth;
  config.listHeight = p.listHeight;
  config.dockRight = p.dockRight;
  config.dockBottom = p.dockBottom;
  config.topCenter = p.topCenter;
  // 横排快照有精确坐标 → 交给 fitWindow 在渲染回真实宽高后一次性落位(repositionBar 仅做粗放,避免渲染前闪一下)
  restorePos = config.layout === 'bar' && !p.topCenter && p.x != null && p.y != null ? { x: p.x, y: p.y } : null;
  saveConfig(config);
  if (wasList !== (config.layout === 'list')) setLayout(config.layout);
  else pushConfig();
  if (config.layout === 'bar') repositionBar();
}
function renamePosition(index: number, name: string): void {
  const p = config.positions[index];
  if (!p) return;
  p.name = name.trim() || p.name;
  saveConfig(config);
  pushConfig();
}
function deletePosition(index: number): void {
  if (index < 0 || index >= config.positions.length) return;
  config.positions.splice(index, 1);
  saveConfig(config);
  pushConfig();
}

function setupTray() {
  try {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('CliPeek — 所有 AI agent 一眼看全');
    tray.setTitle(' ⚪ 0');
    const refresh = () => tray?.setContextMenu(buildMenu());
    tray.on('mouse-down', refresh);
    refresh();
  } catch (err) {
    console.error('[clipeek] tray setup failed:', err);
  }
}

function setupIpc() {
  ipcMain.on('win:resize', (e, w: number, h: number) => {
    const win = winOf(e);
    if (!win) return;
    if (win === listWin) fitWindow(win, w, h); // 竖排列表:独立可拖窗,锚定自身位置
    else if (win === tipWin) positionTip(w, h);
    else fitWindow(win, w, h);
  });
  ipcMain.on('win:minWidth', (e, w: number) => {
    const win = winOf(e);
    if (!win) return;
    const m = winMin.get(win.id) ?? { w: 80, h: 20 };
    m.w = Math.max(80, Math.round(w));
    winMin.set(win.id, m);
  });
  ipcMain.on('win:minHeight', (e, h: number) => {
    const win = winOf(e);
    if (!win) return;
    const m = winMin.get(win.id) ?? { w: 80, h: 20 };
    m.h = Math.max(20, Math.round(h)); // 拉伸高度下限 = 内容自然高度
    winMin.set(win.id, m);
  });
  ipcMain.on('win:dragStart', (e) => startDrag(winOf(e)));
  ipcMain.on('win:dragEnd', () => stopDrag());
  ipcMain.on('win:resizeStart', (e, edge: ResizeEdge) => startResize(winOf(e), edge));
  ipcMain.on('win:resizeEnd', () => stopResize());
  ipcMain.on('win:focusForEdit', (e) => {
    app.focus({ steal: true });
    winOf(e)?.focus();
  });
  ipcMain.on('session:open', (_e, id: string) => openTerminal(id)); // 单击灯/列表行 → 打开对应终端 tab
  ipcMain.on('tip:show', (_e, id: string) => requestShowTip(id));
  ipcMain.on('tip:leave', () => {
    cancelShowTip(); // 取消尚未弹出的首次显示
    scheduleHideTip(); // 已显示的延迟收起
  });
  ipcMain.on('tip:enter', () => cancelHideTip());
  ipcMain.on('tip:editStart', () => {
    tipEditing = true;
    cancelHideTip();
  });
  ipcMain.on('tip:editEnd', () => {
    tipEditing = false;
  });
  ipcMain.on('hud:contextmenu', () => {
    buildMenu().popup({ window: activeWin() ?? undefined });
  });
  ipcMain.on('hud:rename', (_e, id: string, name: string) => {
    const trimmed = (name ?? '').trim();
    if (trimmed) config.names[id] = trimmed;
    else delete config.names[id];
    saveConfig(config);
    pushSessions();
  });
  ipcMain.handle('hud:getConfig', () => config);
  ipcMain.on('settings:open', () => openSettings());
  ipcMain.on('settings:set', (_e, partial: Partial<Config>) => applySettings(partial));
  ipcMain.on('settings:preset', (_e, kind: 'br' | 'bl' | 'tc') => applyPreset(kind));
  ipcMain.on('settings:savePos', () => savePosition());
  ipcMain.on('settings:applyPos', (_e, index: number) => applyPosition(index));
  ipcMain.on('settings:renamePos', (_e, index: number, name: string) => renamePosition(index, name));
  ipcMain.on('settings:delPos', (_e, index: number) => deletePosition(index));
  ipcMain.handle('update:status', () => updater.getStatus());
  ipcMain.on('update:check', () => void updater.check());
  ipcMain.on('update:install', () => updater.installAndRestart());
  ipcMain.on('settings:resize', (_e, h: number) => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    const [w, curH] = settingsWin.getContentSize();
    const want = Math.max(160, Math.round(h));
    // 高度真变了(切 tab)才调;同 tab 内点控件高度不变 → 不 resize → 不抖
    if (Math.abs(want - curH) > 1) settingsWin.setContentSize(w, want);
  });
}

function startPolling() {
  const poll = async () => {
    const all = await Promise.all(adapters.map((a) => a.poll()));
    latest = all.flat();
    pushSessions();
  };
  poll();
  setInterval(poll, 1000);
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();
  installHook();
  if (config.layout === 'list') listMode = 'corner'; // 启动即竖排:列表占屏幕角(在 createWindows 前置好,did-finish-load 才会补发 mode)
  createWindows();
  setupTray();
  setupIpc();
  startPolling();
  registerShortcuts(); // 按 config.shortcuts 注册 ⌘J / ⌘⇧J
  // 自动更新:状态变化时推给设置窗(若开着),就绪时刷新托盘菜单加「重启更新」项。
  updater.onStatus((s) => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:status', s);
    if (s.phase === 'ready') tray?.setContextMenu(buildMenu());
  });
  updater.start();
  // 仅当 OS 登录项与配置不一致才写(默认都 false 时不白调 → 免去 dev 下的 Operation not permitted 噪声)
  if (app.getLoginItemSettings().openAtLogin !== config.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll()); // 退出时释放全局热键

app.on('window-all-closed', () => {
  /* 保持后台 */
});

export type { Session, SessionState, Config };
