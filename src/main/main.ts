import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell, globalShortcut } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Adapter, Config, Session, SessionState, STATE_PRIORITY, SCALE_MIN, SCALE_MAX } from '../shared/types';
import { loadConfig, saveConfig } from './store';
import { ClaudeCodeAdapter } from './adapters/claude';
import { installHook, FOCUS_DIR } from './hook';
import { acknowledge } from './ack';
import { pickNextJump } from './jump';

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

// —— 全局快捷键:⌃⌥J 跳到下一个会话、聚焦其终端、并高亮该灯 ——
// 选目标的纯逻辑在 ./jump 的 pickNextJump(已单测):优先 红▸黄闪▸黄▸绿闪 循环,都没有则在所有绿灯里循环。
const JUMP_SHORTCUT = 'Control+Alt+J'; // = ⌃⌥J;两修饰键、左下相邻好按,且非系统快捷键。改键位改这里(以后可挪进 config)
let lastJumpId: string | null = null;
function jumpToNext(): void {
  const next = pickNextJump(latest, lastJumpId);
  if (!next) return; // 没有可跳的会话(只剩执行中外的…实为 exited/无会话)→ 静默
  lastJumpId = next.id;
  openTerminal(next.id);
  setJumpHighlight(next.id); // 高亮被触发的灯,过会儿自动清;循环再按则换新、旧的立即恢复
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
let tray: Tray | null = null;
let config: Config = loadConfig();
let latest: Session[] = [];

const adapters: Adapter[] = [new ClaudeCodeAdapter()];
const SCALE_STEP = 0.2;
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
// 恢复状态条位置:config.x/y 有效且落在某个显示器内才用,否则回默认右下角(防副屏拔掉后跑到屏外)。
function restoredBarPos(w: number, h: number) {
  if (typeof config.x === 'number' && typeof config.y === 'number') {
    const pt = { x: config.x, y: config.y };
    const d = screen.getDisplayMatching({ x: config.x, y: config.y, width: w, height: h });
    const a = d.bounds;
    if (pt.x + w > a.x && pt.x < a.x + a.width && pt.y + h > a.y && pt.y < a.y + a.height) return pt; // 仍可见
  }
  return defaultPos(w, h);
}

function makeWin(role: 'bar' | 'list' | 'tip', show: boolean): BrowserWindow {
  const pos = role === 'bar' ? restoredBarPos(320, 80) : defaultPos(320, 80); // 状态条恢复上次位置
  const w = new BrowserWindow({
    width: 320,
    height: 80,
    x: pos.x,
    y: pos.y,
    show,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: true,
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
  w.setAlwaysOnTop(true, 'screen-saver');
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

// —— 窗口自适应贴合(作用于来源窗口,锚定屏幕角)——
function fitWindow(win: BrowserWindow, w: number, h: number) {
  const b = win.getBounds();
  const newW = Math.max(1, Math.ceil(w));
  const newH = Math.max(1, Math.ceil(h));
  if ((win === resizeWin && resizeAnchor) || (win === dragWin && dragAnchor)) return; // 手动拉伸/拖动时不抢
  const area = screen.getDisplayMatching(b).bounds;
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
  const area = screen.getDisplayMatching(b).bounds;
  // 窗口比屏还宽/高时上下界反转 → 用 min/max 兜底,否则被钉在边上拖不动
  const loX = Math.min(area.x, area.x + area.width - b.width);
  const hiX = Math.max(area.x, area.x + area.width - b.width);
  const loY = Math.min(area.y, area.y + area.height - b.height);
  const hiY = Math.max(area.y, area.y + area.height - b.height);
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
    }
    saveConfig(config);
    pushConfig();
  }
  resizeWin = null;
  resizeAnchor = null;
}
// 记住状态条位置(供拖动结束时调用)
function saveBarPos() {
  if (!barWin) return;
  const b = barWin.getBounds();
  config.x = b.x;
  config.y = b.y;
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
  return Menu.buildFromTemplate([
    { label: config.layout === 'list' ? '切换横排' : '切换竖排', click: () => setLayout(config.layout === 'list' ? 'bar' : 'list') },
    {
      label: config.showNames ? '横排:隐藏灯下名字' : '横排:显示灯下名字',
      enabled: config.layout !== 'list',
      click: () => {
        config.showNames = !config.showNames;
        saveConfig(config);
        pushConfig();
      },
    },
    { label: '放大', enabled: config.scale < SCALE_MAX, click: () => setScale(config.scale + SCALE_STEP) },
    { label: '缩小', enabled: config.scale > SCALE_MIN, click: () => setScale(config.scale - SCALE_STEP) },
    {
      label: '恢复默认大小',
      // 按当前模式判断是否可恢复 + 只重置当前模式那套尺寸
      enabled:
        config.scale !== 1 ||
        (config.layout === 'list'
          ? config.listWidth !== null || config.listHeight !== null
          : config.width !== null || config.height !== null),
      click: () => {
        if (config.layout === 'list') {
          config.listWidth = null; // 竖排:列表宽高回到默认
          config.listHeight = null;
        } else {
          config.width = null; // 横排:状态条宽回自适应
          config.height = null; // 状态条高回贴合 Dock
        }
        setScale(1); // scale 复位(内部 saveConfig + pushConfig,一并保存上面几项)
      },
    },
    {
      label: '重置位置',
      click: () => {
        const a = activeWin();
        if (!a) return;
        const [w, h] = a.getSize();
        const { x, y } = defaultPos(w, h, screen.getDisplayMatching(a.getBounds())); // 回到当前所在屏的右下角
        a.setPosition(x, y);
        if (a === barWin) saveBarPos(); // 重置位置后也记住
        pushDock();
      },
    },
    { type: 'separator' },
    { label: '退出 clipeek', role: 'quit' },
  ]);
}
function setScale(next: number) {
  config.scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, next)) * 100) / 100;
  saveConfig(config);
  pushConfig();
}
function setupTray() {
  try {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('clipeek — 所有 AI agent 一眼看全');
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
  if (!globalShortcut.register(JUMP_SHORTCUT, jumpToNext)) {
    console.error('[clipeek] 全局快捷键注册失败(可能被别的程序占用):', JUMP_SHORTCUT);
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
