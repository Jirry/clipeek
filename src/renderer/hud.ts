import type { Config, Session, SessionState } from '../shared/types';
import { STATE_PRIORITY } from '../shared/types';

// 两套窗口共用,?role= 区分:
//   bar  横排窗:一排灯 + 悬停弹框(内置预留槽,零抖动)
//   list 竖排窗:整个竖排列表
declare global {
  interface Window {
    clipeek: {
      onSessions(cb: (s: Session[]) => void): () => void;
      onConfig(cb: (c: Config) => void): () => void;
      onDock(cb: (d: { bottom: boolean; right: boolean; dockH: number; home: string }) => void): () => void;
      getConfig(): Promise<Config>;
      openMenu(): void;
      rename(id: string, name: string): void;
      winResize(w: number, h: number): void;
      setMinWidth(w: number): void;
      setMinHeight(h: number): void;
      dragStart(): void;
      dragEnd(): void;
      resizeStart(edge: string): void;
      resizeEnd(): void;
      onResizing(cb: (w: number, h: number) => void): () => void;
      openSession(id: string): void;
      focusForEdit(): void;
      onListWidth(cb: (w: number) => void): () => void;
      onJumpHighlight(cb: (id: string | null) => void): () => void;
      tipShow(id: string): void;
      tipLeave(): void;
      tipEnter(): void;
      tipEditStart(): void;
      tipEditEnd(): void;
      onTipSession(cb: (s: Session, width: number, animate: boolean, force: boolean) => void): () => void;
    };
  }
}

const roleParam = new URLSearchParams(location.search).get('role');
const ROLE: 'bar' | 'list' | 'tip' = roleParam === 'list' ? 'list' : roleParam === 'tip' ? 'tip' : 'bar';
const MARGIN = 0; // 无边距:玻璃面完全贴紧屏幕边缘
const VMARGIN = MARGIN;
const MAX_DOTS = 6;

const STATE_COLOR: Record<SessionState, string> = {
  done: 'var(--green)',
  attention: 'var(--green)', // 绿闪·该你了(颜色同绿,靠闪烁区分)
  working: 'var(--amber)',
  needsInput: 'var(--amber)',
  error: 'var(--red)',
  exited: 'var(--gray)',
};
let sessions: Session[] = [];
let config: Config = {
  x: null,
  y: null,
  scale: 1,
  width: null,
  height: null,
  listWidth: null,
  listHeight: null,
  layout: 'bar',
  showNames: false,
  names: {},
};
let dock = { bottom: true, right: true, dockH: 56, home: '' };
let editingId: string | null = null;
let highlightId: string | null = null; // ⌃⌥J 触发后高亮的会话 id(主进程下发,过会儿清空)
let tipSession: Session | null = null; // 提示框窗:当前要显示的那条会话
let tipContentW = 0; // 提示框内容宽 = 灯条玻璃宽(主进程下发)
let pointerDown = false; // 状态条上指针按下中 → 抑制悬停提示框 + 暂停重渲染(保住捕获元素)
let savedScrollLeft = 0; // 跨重渲染保持的灯条横向滚动位置
// 悬停延迟由主进程统一处理(它知道提示框是否已显示:已显示则立即换、隐藏则延迟弹出)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
// 点阵拖动手柄:n 个点(默认 8)。cls 'grip'=竖向 2 列(灯条左侧);'grip grip-bar'=横向(列表顶部)。
function makeGrip(n = 8, cls = 'grip'): HTMLElement {
  const grip = el('div', cls);
  grip.title = '按住拖动';
  for (let i = 0; i < n; i++) grip.appendChild(el('span', 'grip-dot'));
  grip.addEventListener('pointerdown', (e) => {
    if (editingId) return; // 改名进行中,别误启动拖窗
    e.stopPropagation(); // 别触发灯区滚动 / 列表内容
    startPointerDrag(e); // 拖整窗
  });
  return grip;
}
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}
function prettyPath(cwd: string): string {
  return dock.home && cwd.startsWith(dock.home) ? '~' + cwd.slice(dock.home.length) : cwd;
}
function summary(): string {
  const live = sessions.filter((s) => s.state !== 'exited');
  const by = (st: SessionState) => live.filter((s) => s.state === st).length;
  const parts: string[] = [];
  if (by('error')) parts.push(`${by('error')} 异常`);
  if (by('needsInput')) parts.push(`${by('needsInput')} 待介入`);
  if (by('working')) parts.push(`${by('working')} 执行`);
  if (by('attention')) parts.push(`${by('attention')} 该你了`);
  if (by('done')) parts.push(`${by('done')} 完成`);
  return parts.join(' · ') || '空闲';
}
function pathEl(cwd: string): HTMLElement {
  const pretty = prettyPath(cwd);
  const path = el('div', 'panel-path'); // 不设原生 title:这种置顶窗口上系统提示会被窗口盖住
  const cut = pretty.lastIndexOf('/');
  path.appendChild(el('span', 'path-head', cut >= 0 ? pretty.slice(0, cut + 1) : ''));
  path.appendChild(el('span', 'path-tail', cut >= 0 ? pretty.slice(cut + 1) : pretty));
  return path;
}
function endEdit(commit: { id: string; name: string } | null): void {
  if (commit) window.clipeek.rename(commit.id, commit.name);
  editingId = null;
  if (ROLE === 'tip') window.clipeek.tipEditEnd(); // 告知主进程编辑结束 → 可正常收起
  if (!pointerDown) render(); // 拖动中不重渲染(否则销毁捕获元素);拖动结束自会重渲染
}
function editableName(s: Session, cls = 'panel-name'): HTMLElement {
  const wrap = el('div', cls);
  if (editingId === s.id) {
    const input = el('input');
    input.value = s.name;
    let finished = false;
    const finish = (commit: { id: string; name: string } | null) => {
      if (finished) return; // 防重入:Esc/Enter 后 render 移除 input 触发的 blur 不能再次提交
      finished = true;
      input.removeEventListener('blur', onBlur);
      endEdit(commit);
    };
    const onBlur = () => finish({ id: s.id, name: input.value }); // 失焦 = 提交
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish({ id: s.id, name: input.value });
      else if (e.key === 'Escape') finish(null); // 取消,不提交
    });
    input.addEventListener('blur', onBlur);
    wrap.appendChild(input);
    setTimeout(() => input.focus(), 0);
  } else {
    const enterEdit = () => {
      editingId = s.id;
      if (ROLE === 'tip') window.clipeek.tipEditStart(); // 告知主进程进入编辑 → 别因鼠标移出而隐藏
      window.clipeek.focusForEdit();
      render();
    };
    wrap.appendChild(el('span', 'name-text', s.name));
    const pencil = el('span', 'edit-pencil', '✏︎'); // 编辑图标(︎ 强制单色文本);点它改名(单击行是打开终端)
    pencil.addEventListener('pointerdown', (e) => e.stopPropagation()); // 别触发拖动
    pencil.addEventListener('click', (e) => {
      e.stopPropagation(); // 别触发「单击打开终端」
      enterEdit();
    });
    wrap.appendChild(pencil);
  }
  return wrap;
}
function buildRow(s: Session, showPath: boolean): HTMLElement {
  const pr = el('div', 'panel-row');
  pr.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('input, .edit-pencil')) return; // 编辑输入/铅笔不触发打开
    window.clipeek.openSession(s.id); // 单击行 → 打开对应终端 tab
  });
  const dot = el('div', s.id === highlightId ? 'panel-dot jumped' : 'panel-dot');
  dot.style.background = STATE_COLOR[s.state];
  const blinking = s.state === 'needsInput' || s.state === 'attention'; // 黄闪 / 绿闪
  // 同色微光晕(闪烁态稍强),柔和不生硬;颜色随状态,故内联设置
  const glow = Math.round((blinking ? 6 : 3) * (config.scale || 1));
  dot.style.boxShadow = `0 0 ${glow}px ${STATE_COLOR[s.state]}`;
  if (blinking) dot.style.animation = 'blink 1.2s ease-in-out infinite';
  pr.appendChild(dot);
  pr.appendChild(editableName(s));
  if (showPath) pr.appendChild(pathEl(s.cwd)); // 窄列表时隐藏路径列
  pr.appendChild(el('div', 'panel-time', relTime(s.lastActivity)));
  return pr;
}
// 统一指针捕获:setPointerCapture + 多重兜底(window 的 pointerup/blur)。
// 即便捕获元素因重渲染被销毁,window 上仍能收到 pointerup → 可靠结束,绝不会「松手还在动」。
function capturePointer(
  t: HTMLElement,
  e: PointerEvent,
  onMove: ((ev: PointerEvent) => void) | null,
  onEnd: () => void,
): void {
  pointerDown = true;
  try {
    t.setPointerCapture(e.pointerId);
  } catch {
    /* 忽略 */
  }
  let done = false;
  const end = (ev: PointerEvent) => {
    if (done) return;
    done = true;
    if (onMove) t.removeEventListener('pointermove', onMove);
    t.removeEventListener('pointerup', end);
    t.removeEventListener('pointercancel', end);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('blur', end as EventListener);
    try {
      t.releasePointerCapture(ev.pointerId ?? e.pointerId);
    } catch {
      /* 已释放 */
    }
    pointerDown = false;
    onEnd();
  };
  if (onMove) t.addEventListener('pointermove', onMove);
  t.addEventListener('pointerup', end);
  t.addEventListener('pointercancel', end);
  window.addEventListener('pointerup', end); // 兜底:元素被重渲染销毁后仍能收到
  window.addEventListener('blur', end as EventListener); // 兜底:窗口失焦也停
}

// 拖动:主进程光标轮询移动(平滑),起止由 capturePointer 可靠把控(松手必停)。
function startPointerDrag(e: PointerEvent): void {
  if (e.button !== 0) return;
  window.clipeek.tipLeave(); // 按下即收掉提示框
  window.clipeek.dragStart(); // 主进程开始轮询光标移动窗口
  capturePointer(e.currentTarget as HTMLElement, e, null, () => window.clipeek.dragEnd());
}
// 灯区按下:拖动 = 横向滚动(等同滑动滚动条);原地点击灯 = 展开/收起列表。不拖窗。
function startBarScroll(e: PointerEvent): void {
  if (e.button !== 0) return;
  const bar = e.currentTarget as HTMLElement;
  if (e.target === bar && (e.offsetX > bar.clientWidth || e.offsetY > bar.clientHeight)) return; // 原生滚动条
  const startX = e.screenX;
  const startScroll = bar.scrollLeft;
  const tapTarget = e.target as HTMLElement;
  let moved = false;
  window.clipeek.tipLeave();
  const onMove = (ev: PointerEvent) => {
    const dx = ev.screenX - startX;
    if (!moved && Math.abs(dx) < 4) return; // 死区:小位移视为点击
    moved = true;
    bar.scrollLeft = startScroll - dx; // 拖动 = 横向滚动
  };
  capturePointer(bar, e, onMove, () => {
    if (moved) return;
    const cell = tapTarget.closest('.cell') as HTMLElement | null; // 原地点灯 → 直接打开对应终端 tab
    if (cell?.dataset.sid) window.clipeek.openSession(cell.dataset.sid);
  });
}
// 拉伸手柄:主进程轮询调宽/调高/对角,起止由 capturePointer 可靠把控
function startPointerResize(
  e: PointerEvent,
  edge: 'left' | 'right' | 'top' | 'bottom' | 'topleft' | 'topright' | 'botleft' | 'botright',
): void {
  if (e.button !== 0) return;
  e.stopPropagation();
  window.clipeek.tipLeave();
  window.clipeek.resizeStart(edge);
  capturePointer(e.currentTarget as HTMLElement, e, null, () => window.clipeek.resizeEnd());
}
// 对称小边距:不依赖 dock 方向 → 拖动越过屏幕中线也不会左右/上下互换造成玻璃瞬移。
function barPad() {
  return { top: MARGIN, bottom: MARGIN, left: 0, right: 0 };
}

// ============ 横排窗(只一排灯;悬停看名用系统原生提示)============
// 灯条渲染指纹:展示数据没变就不重建 DOM(否则每秒轮询会打断跑马灯动画、也无谓重排)
function barSig(): string {
  return (
    sessions.map((x) => `${x.id}:${x.state}:${x.name}`).join('|') +
    `|${config.showNames}|${config.scale}|${config.width}|${config.height}|${dock.dockH}|${highlightId}`
  );
}
let lastBarSig = '';
function renderBar(): void {
  const app = document.getElementById('app')!;
  const sig = barSig();
  if (sig === lastBarSig && app.querySelector('.bar-surface')) return; // 无变化 → 不重建,跑马灯继续
  lastBarSig = sig;
  // 注意:不在这里读 .bar-scroll.scrollLeft —— 连续重渲染时会读到刚建好(scrollLeft=0)的新元素而丢位置。
  // savedScrollLeft 由 .bar-scroll 的 scroll 事件实时维护(见下),这里只在 fitBar 里恢复。
  document.documentElement.style.setProperty('--scale', String(config.scale));
  const p = barPad();
  app.style.margin = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;

  const bar = el('div', 'bar-surface');
  bar.style.minHeight = `${barHeight()}px`;
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.clipeek.openMenu();
  });
  // 边:left/right 调宽、top/bottom 调高;四角:同时调宽+调高
  for (const edge of ['left', 'right', 'top', 'bottom', 'topleft', 'topright', 'botleft', 'botright'] as const) {
    const handle = el('div', `resize-handle ${edge}`);
    handle.addEventListener('pointerdown', (e) => startPointerResize(e, edge));
    bar.appendChild(handle);
  }
  // 离开整条状态条 → 收提示框(灯与灯之间靠 mouseenter 接力,不会闪)
  bar.addEventListener('mouseleave', () => window.clipeek.tipLeave());

  // 左侧拖动手柄(8 点):固定在最左,不随灯滚动;只有按住这里才拖整个窗口
  bar.appendChild(makeGrip(8));

  // 滚动区:只包含灯。拖动 = 横向滚动;原地点灯 = 浮出/收起列表。手柄不在其中 → 滚动时手柄不动。
  const scroll = el('div', 'bar-scroll');
  scroll.addEventListener('pointerdown', startBarScroll);
  scroll.addEventListener('scroll', () => {
    savedScrollLeft = scroll.scrollLeft; // 实时记录滚动位置,跨重渲染保持
    updateScrollFade();
  });
  if (sessions.length === 0) scroll.appendChild(el('div', 'empty', '无活跃会话'));
  for (const s of sessions) {
    const cell = el('div', 'cell');
    cell.dataset.sid = s.id; // 供单击/双击区分时取会话 id
    cell.appendChild(el('div', `light ${s.state}${s.id === highlightId ? ' jumped' : ''}`));
    if (config.showNames) {
      const name = el('div', 'name'); // 跑马灯容器:超出时左右来回滚,不截断
      name.appendChild(el('span', 'name-inner', s.name));
      cell.appendChild(name);
    }
    cell.addEventListener('mouseenter', () => {
      if (pointerDown) return; // 拖动/点击中不弹;延迟由主进程把控
      window.clipeek.tipShow(s.id);
    });
    scroll.appendChild(cell);
  }
  bar.appendChild(scroll);

  // 边缘箭头按钮:哪侧有隐藏的灯就出现哪侧,点一下滚动一个灯的宽度(灯宽 + 间隔)
  const step = () => {
    const c = scroll.querySelector('.cell') as HTMLElement | null;
    return (c ? c.offsetWidth : 60 * (config.scale || 1)) + 13 * (config.scale || 1); // 一个灯位 = 灯宽 + gap
  };
  const leftArrow = el('div', 'scroll-arrow left', '‹');
  leftArrow.title = '向左';
  leftArrow.addEventListener('click', () => scroll.scrollBy({ left: -step(), behavior: 'smooth' }));
  const rightArrow = el('div', 'scroll-arrow right', '›');
  rightArrow.title = '向右';
  rightArrow.addEventListener('click', () => scroll.scrollBy({ left: step(), behavior: 'smooth' }));
  bar.appendChild(leftArrow);
  bar.appendChild(rightArrow);

  app.replaceChildren(bar);
  fitBar();
}
// 标记哪些名字溢出(可在悬停时跑马灯);默认截断省略号,只有 .cell:hover 才滚动(见 CSS)
function applyMarquee(): void {
  document.querySelectorAll('.name').forEach((n) => {
    const box = n as HTMLElement;
    const inner = box.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const overflow = inner.scrollWidth - box.clientWidth;
    if (overflow > 1) {
      box.classList.add('can-marquee');
      box.style.setProperty('--mq-shift', `-${overflow}px`);
      box.style.setProperty('--mq-dur', `${Math.max(2.5, overflow / 28)}s`); // 文字越长滚得越久,速度恒定
    } else {
      box.classList.remove('can-marquee');
      box.style.removeProperty('--mq-shift');
    }
  });
}
// 可滚动性提示:有更多内容的一侧给灯条加渐隐 + 显示翻页箭头;无溢出则都不显示
function updateScrollFade(): void {
  const scroll = document.querySelector('.bar-scroll') as HTMLElement | null;
  if (!scroll) return;
  const max = scroll.scrollWidth - scroll.clientWidth;
  const moreLeft = scroll.scrollLeft > 1;
  const moreRight = scroll.scrollLeft < max - 1;
  scroll.classList.toggle('more-left', moreLeft);
  scroll.classList.toggle('more-right', moreRight);
  (document.querySelector('.scroll-arrow.left') as HTMLElement | null)?.classList.toggle('show', moreLeft);
  (document.querySelector('.scroll-arrow.right') as HTMLElement | null)?.classList.toggle('show', moreRight);
}
// 内容自然高度(最小高度兜底):内边距 + 灯 + (显名时)名字 + 边框,随 scale/showNames 变化。
function naturalHeight(): number {
  const s = config.scale || 1;
  const padV = 8 * s; // --pad-v
  const dot = 20 * s; // --dot
  const nameBlock = config.showNames ? 4 * s + 13 * s : 0; // cell 间隔 + 名字行高
  return Math.ceil(2 * padV + dot + nameBlock + 2); // +2 上下边框
}
// 状态条高度:用户拖过顶边 → config.height;否则默认 = Dock 高 × 缩放;但都不低于内容自然高度。
function barHeight(): number {
  const def = config.height != null ? config.height : (dock.dockH - 2 * VMARGIN) * (config.scale || 1);
  return Math.max(def, naturalHeight());
}
function naturalWidth(p: { left: number; right: number }): number {
  const s = config.scale || 1;
  const n = Math.min(Math.max(sessions.length, 4), MAX_DOTS);
  const cell = 60 * s;
  const gap = 13 * s;
  const padH = 16 * s;
  const grip = 19 * s; // 左侧拖动手柄宽(2 点 3px + 间隔 3px + 左右各 5px padding)
  let content = 2 * padH + 2 + grip + gap; // 含手柄 + 手柄与首灯的间隔
  if (n > 0) content += n * cell + (n - 1) * gap;
  return Math.ceil(content + p.left + p.right);
}
let fitPending = false;
function fitBar(): void {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    const app = document.getElementById('app')!;
    const p = barPad();
    const bar = app.querySelector('.bar-surface') as HTMLElement | null;
    const minW = naturalWidth(p); // 默认宽 = 灯数夹到 [4,6] 的宽度
    window.clipeek.setMinWidth(minW);
    window.clipeek.setMinHeight(naturalHeight()); // 拉伸高度的下限 = 内容自然高度(保证灯+名字不被截)
    const winW = config.width != null ? Math.max(config.width, minW) : minW;
    if (bar) bar.style.width = `${winW - p.left - p.right}px`;
    const scroll = app.querySelector('.bar-scroll') as HTMLElement | null;
    if (scroll) scroll.scrollLeft = savedScrollLeft; // 宽度设好后恢复横向滚动位置
    updateScrollFade(); // 宽度定后刷新边缘渐隐
    applyMarquee(); // 宽度定后判定哪些名字需要跑马灯
    const r = app.getBoundingClientRect();
    window.clipeek.winResize(winW, Math.ceil(r.height + p.top + p.bottom));
  });
}

// ============ 竖排窗 ============
const PATH_MIN_W = 380; // 列表窄于此宽则隐藏路径列(默认 300 宽时不显示,拉宽到 ≥380 才显示)
function listDefaultW(): number {
  return Math.round(300 * (config.scale || 1)); // 竖排默认宽 = 最小宽(两者对齐,只能加宽)
}
function listMinH(): number {
  // 最小高:手柄 + 摘要 + 至少 3 行会话 + 内边距
  const s = config.scale || 1;
  return Math.round((16 + 16 + 28 + 3 * 28 + 2 * 2 + 2) * s); // ≈ 156*s
}
function renderList(): void {
  const app = document.getElementById('app')!;
  document.documentElement.style.setProperty('--scale', String(config.scale));
  const p = barPad();
  app.style.margin = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;

  // 列表窗只在竖排模式出现(横排只剩状态条)。独立默认宽 300×scale,用户拖过则用 config.listWidth。
  const effW = config.listWidth != null ? config.listWidth : listDefaultW();
  const showPath = effW >= PATH_MIN_W; // 窄于阈值则隐藏路径列

  const hud = el('div', 'hud overlay-surface');
  hud.style.width = `${effW}px`;
  if (config.listHeight != null) {
    hud.style.height = `${config.listHeight}px`; // 用户拖过高度 → 固定高、内部滚动
    hud.style.maxHeight = 'none';
    hud.classList.add('fixed-h');
  }
  hud.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.clipeek.openMenu();
  });
  const panel = el('div', 'panel');
  panel.appendChild(makeGrip(8, 'grip grip-bar')); // 顶部横向拖动手柄
  panel.appendChild(el('div', 'panel-summary', summary()));
  const list = el('div', 'panel-list');
  const ordered = [...sessions].sort(
    (a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] || b.lastActivity - a.lastActivity,
  );
  for (const s of ordered) list.appendChild(buildRow(s, showPath));
  panel.appendChild(list);
  hud.appendChild(panel);

  // 四边四角拉伸手柄
  for (const edge of ['left', 'right', 'top', 'bottom', 'topleft', 'topright', 'botleft', 'botright'] as const) {
    const handle = el('div', `resize-handle ${edge}`);
    handle.addEventListener('pointerdown', (e) => startPointerResize(e, edge));
    hud.appendChild(handle);
  }

  app.replaceChildren(hud);
  fitList();
}
let fitPendingL = false;
function fitList(): void {
  if (fitPendingL) return;
  fitPendingL = true;
  requestAnimationFrame(() => {
    fitPendingL = false;
    const app = document.getElementById('app')!;
    const p = barPad();
    window.clipeek.setMinWidth(listDefaultW()); // 最小宽 = 默认宽(对齐,只能加宽)
    window.clipeek.setMinHeight(listMinH()); // 最小高 = 手柄+摘要+至少 3 行
    const r = app.getBoundingClientRect();
    window.clipeek.winResize(Math.ceil(r.width + p.left + p.right), Math.ceil(r.height + p.top + p.bottom));
  });
}

// ============ 提示框窗(横排悬停灯,与灯条等宽、贴其上方)============
function renderTip(animate = false): void {
  const app = document.getElementById('app')!;
  document.documentElement.style.setProperty('--scale', String(config.scale));
  const p = barPad();
  app.style.margin = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;

  // animate 仅首次弹出为 true → 灯间切换不重放淡入(不再一闪一闪)
  const hud = el('div', animate ? 'hud tip-surface tip-anim' : 'hud tip-surface'); // 玻璃面,与灯条同宽
  if (tipContentW > 0) hud.style.width = `${tipContentW}px`;
  // 移到提示框上 → 保持显示;离开 → 收起(编辑中不收,免得输入被打断)
  hud.addEventListener('mouseenter', () => window.clipeek.tipEnter());
  hud.addEventListener('mouseleave', () => {
    if (!editingId) window.clipeek.tipLeave();
  });
  const card = el('div', 'tip-card');
  if (tipSession) {
    card.appendChild(editableName(tipSession, 'panel-name')); // 名字可编辑(双击)
    card.appendChild(pathEl(tipSession.cwd)); // 路径(home→~,中间截断)
  }
  hud.appendChild(card);
  app.replaceChildren(hud);
  fitTip();
}
let fitPendingT = false;
function fitTip(): void {
  if (fitPendingT) return;
  fitPendingT = true;
  requestAnimationFrame(() => {
    fitPendingT = false;
    const app = document.getElementById('app')!;
    const p = barPad();
    const r = app.getBoundingClientRect();
    // 宽度无所谓(主进程用灯条宽对齐),只要高度准 → 贴合
    window.clipeek.winResize(Math.ceil(r.width + p.left + p.right), Math.ceil(r.height + p.top + p.bottom));
  });
}

// ============ 公共 ============
function render(): void {
  if (ROLE === 'list') renderList();
  else if (ROLE === 'tip') renderTip();
  else renderBar();
}
async function init() {
  config = await window.clipeek.getConfig();
  // pointerDown 期间不重渲染:否则 app.replaceChildren 会销毁正被 setPointerCapture 的元素 → 松手收不到 pointerup
  window.clipeek.onConfig((c) => {
    config = c;
    if (!editingId && !pointerDown) render();
  });
  window.clipeek.onDock((d) => {
    dock = d;
    if (!editingId && !pointerDown) render();
  });
  window.clipeek.onJumpHighlight((id) => {
    highlightId = id; // 高亮/取消高亮被 ⌃⌥J 触发的灯
    if (!editingId && !pointerDown) render();
  });
  if (ROLE === 'tip') {
    window.clipeek.onTipSession((s, width, animate, force) => {
      if (editingId) {
        tipContentW = width;
        return; // 编辑中:不回填数据、不重渲染,免得打断输入(否则输入框值会错乱)
      }
      const changed =
        !tipSession ||
        tipSession.id !== s.id ||
        tipSession.name !== s.name ||
        tipSession.cwd !== s.cwd ||
        tipContentW !== width;
      tipSession = s;
      tipContentW = width;
      // force(首次弹出,即便内容没变也要重渲染以触发显示)或内容变了才渲染;animate 仅首次弹出为 true
      if (force || changed) renderTip(animate);
    });
  } else {
    window.clipeek.onSessions((s) => {
      sessions = s;
      if (!editingId && !pointerDown) render(); // 改名后立即生效;拖动/滚动/拉伸中不重渲染(保住捕获元素)
    });
  }
  if (ROLE === 'bar') {
    window.clipeek.onResizing((w, h) => {
      const bar = document.querySelector('.bar-surface') as HTMLElement | null;
      if (bar) {
        const p = barPad();
        bar.style.width = `${Math.max(0, w - p.left - p.right)}px`;
        bar.style.minHeight = `${Math.max(0, h - p.top - p.bottom)}px`; // 调高时同步玻璃面高度
      }
    });
  } else if (ROLE === 'list') {
    window.clipeek.onListWidth(() => {
      // 主进程进入竖排时发来,用于触发列表渲染+显示(宽度由 config.listWidth 决定,值本身不用)
      if (!editingId && !pointerDown) render();
    });
    window.clipeek.onResizing((w, h) => {
      // 拉伸列表时,让玻璃面跟着窗口实时填满(否则拖动期间玻璃比窗口小)
      const hud = document.querySelector('.overlay-surface') as HTMLElement | null;
      if (hud) {
        hud.style.width = `${w}px`;
        hud.style.height = `${h}px`;
        hud.style.maxHeight = 'none';
        hud.classList.add('fixed-h'); // 拖拽中也按固定高:内部滚动、撑满
      }
    });
  }
  render();
}
init();
