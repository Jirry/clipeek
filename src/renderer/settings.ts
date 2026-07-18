import type { Config, SavedPosition, UpdateStatus, LightColor, LightFx, LightStateKey } from '../shared/types';
import { DEFAULT_CONFIG, SCALE_MIN, SCALE_MAX, BLINK_MIN_MS, BLINK_MAX_MS, TOOL_SHAPES, DEFAULT_TOOL_SHAPE } from '../shared/types';
import { shapeSvg } from './shapes';
import type { ClipeekApi } from '../main/preload';

// 设置窗:mac 桌面 app 风(参考 AirBuddy)。顶部图标标签切面板;控件用 macOS 系统原生;表单式布局。
const api = (window as unknown as { clipeek: ClipeekApi }).clipeek;

// 顶部标签的单色 stroke 图标
const ICONS: Record<string, string> = {
  shortcuts:
    '<svg viewBox="0 0 24 24"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3z"/></svg>',
  appearance:
    '<svg viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  window:
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>',
  lights:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.6"/><circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="19" r="2.6"/></svg>',
  shapes:
    '<svg viewBox="0 0 24 24"><circle cx="7" cy="7" r="4"/><rect x="13.5" y="3" width="8" height="8" rx="1.2"/><path d="M12 13.5L18.5 22H5.5Z"/></svg>',
  general:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};
const TABS = [
  { key: 'shortcuts', label: '快捷键' },
  { key: 'appearance', label: '外观' },
  { key: 'lights', label: '灯语' },
  { key: 'shapes', label: '图形' },
  { key: 'window', label: '窗口' },
  { key: 'general', label: '通用' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

let cfg: Config = DEFAULT_CONFIG;
let activeTab: TabKey = 'shortcuts';
let recording: 'jump' | 'jumpAll' | null = null;
let hintMsg = '';
let upd: UpdateStatus = { phase: 'idle', current: '', supported: false };

// —— accelerator 显示 & 从键盘事件构造 ——
const SYM: Record<string, string> = {
  Command: '⌘',
  Cmd: '⌘',
  CommandOrControl: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
};
function accelParts(a: string): string[] {
  return a.split('+').map((t) => SYM[t] ?? t);
}
function mainKey(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F[0-9]{1,2}$/.test(c)) return c;
  const map: Record<string, string> = {
    Space: 'Space',
    Enter: 'Return',
    Tab: 'Tab',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Slash: '/',
    Period: '.',
    Comma: ',',
    Minus: '-',
    Equal: '=',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
  };
  return map[c] ?? null;
}
function accelFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = mainKey(e);
  if (!key || !mods.length) return null;
  return [...mods, key].join('+');
}

// —— DOM 小工具 ——
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
// 表单行:标签与控件同一行、垂直居中对齐;说明小字另起一行,左对齐到控件列。
function field(label: string, control: HTMLElement, sub?: string): HTMLElement {
  const f = el('div', 'field');
  const main = el('div', 'field-main');
  const l = el('div', 'field-label', label);
  const c = el('div', 'field-control');
  c.appendChild(control);
  main.append(l, c);
  f.appendChild(main);
  if (sub) f.appendChild(el('div', 'field-sub', sub));
  return f;
}

// —— 自绘控件(桌面尺度,统一设计语言) ——
function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const b = el('button', checked ? 'check on' : 'check');
  b.innerHTML = '<svg viewBox="0 0 12 12"><polyline points="2.5,6.4 5,9 9.5,3.4"/></svg>';
  b.onclick = () => {
    const v = !b.classList.contains('on');
    b.classList.toggle('on', v); // 点击即时反馈,settingsSet 回推后静默 render 终态一致
    onChange(v);
  };
  return b;
}
// 布局选择:横/竖排各用红黄绿三色灯点示意,呼应 HUD 本身
function layoutToggle(): HTMLElement {
  const wrap = el('div', 'lay');
  const mk = (v: 'bar' | 'list', label: string, dotsCls: string): HTMLElement => {
    const o = el('button', cfg.layout === v ? 'lay-opt on' : 'lay-opt');
    const dots = el('span', dotsCls);
    for (const c of ['r', 'y', 'g']) dots.appendChild(el('span', `dot ${c}`));
    o.append(dots, el('span', undefined, label));
    o.onclick = () => {
      if (cfg.layout !== v) api.settingsSet({ layout: v });
    };
    return o;
  };
  wrap.append(mk('bar', '横排', 'dots-h'), mk('list', '竖排', 'dots-v'));
  return wrap;
}
// 菜单栏图标样式:固定图标(单色三盏灯) / 红绿灯(按最紧要的灯着色)
function trayStyleToggle(): HTMLElement {
  const wrap = el('div', 'lay');
  const mk = (v: 'icon' | 'lights', label: string): HTMLElement => {
    const o = el('button', cfg.trayStyle === v ? 'lay-opt on' : 'lay-opt');
    o.append(el('span', undefined, label));
    o.onclick = () => {
      if (cfg.trayStyle !== v) api.settingsSet({ trayStyle: v });
    };
    return o;
  };
  wrap.append(mk('icon', '固定图标'), mk('lights', '红绿灯'));
  return wrap;
}
function stepper(): HTMLElement {
  const wrap = el('div', 'stepper');
  const minus = el('button', undefined, '−');
  minus.disabled = cfg.scale <= SCALE_MIN + 1e-9;
  minus.onclick = () => api.settingsSet({ scale: cfg.scale - 0.2 });
  const val = el('span', 'val', `${Math.round(cfg.scale * 100)}%`);
  const plus = el('button', undefined, '+');
  plus.disabled = cfg.scale >= SCALE_MAX - 1e-9;
  plus.onclick = () => api.settingsSet({ scale: cfg.scale + 0.2 });
  wrap.append(minus, val, plus);
  return wrap;
}
// —— 位置预设 / 自定义快照 ——
function posDesc(p: SavedPosition): string {
  return `${p.layout === 'bar' ? '横排' : '竖排'} · ${p.showNames ? '灯下显名' : '不显名'} · 缩放 ${Math.round(p.scale * 100)}%`;
}
function startRename(nameEl: HTMLElement, current: string, onRename: (v: string) => void): void {
  const input = el('input', 'pos-rename');
  input.type = 'text';
  input.value = current;
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && input.value.trim()) onRename(input.value.trim()); // 回推 → onConfig → 重渲染
    else renderPanel(); // 取消 → 直接恢复
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(true);
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}
function keys(which: 'jump' | 'jumpAll'): HTMLElement {
  if (recording === which) {
    const b = el('button', 'keys recording', '录制中…');
    b.onclick = () => {
      recording = null;
      hintMsg = '';
      renderPanel();
    };
    return b;
  }
  const b = el('button', 'keys');
  for (const p of accelParts(cfg.shortcuts[which])) b.appendChild(el('kbd', undefined, p));
  b.onclick = () => {
    recording = which;
    hintMsg = '';
    renderPanel();
  };
  return b;
}

// —— 各面板 ——
function panelShortcuts(): HTMLElement[] {
  const scHint = hintMsg || (recording ? '按下想要的组合(需含 ⌘ / ⌃ / ⌥ / ⇧),Esc 取消。' : '点键帽即可重新录制。');
  return [
    field('智能跳转', keys('jump'), '只在需要关注的会话间循环'),
    field('全量循环', keys('jumpAll'), '在所有灯之间按顺序切换'),
    el('div', hintMsg ? 'hint warn' : 'hint', scHint),
  ];
}
// CLI → 灯图形 选择器:一排图形色块,点选即用(仿灯语的 swatch)。形状分 CLI、颜色分状态。
function shapePicker(tool: string): HTMLElement {
  const wrap = el('div', 'shape-pick');
  const cur = cfg.toolShapes[tool] ?? DEFAULT_TOOL_SHAPE;
  for (const sh of TOOL_SHAPES) {
    const b = el('button', cur === sh ? 'shape-swatch on' : 'shape-swatch');
    b.innerHTML = shapeSvg(sh);
    b.title = sh;
    b.onclick = () => api.settingsSet({ toolShapes: { ...cfg.toolShapes, [tool]: sh } });
    wrap.appendChild(b);
  }
  return wrap;
}
function panelAppearance(): HTMLElement[] {
  return [
    field('缩放', stepper()),
    field('布局', layoutToggle()),
    field('灯下显示名字', checkbox(cfg.showNames, (v) => api.settingsSet({ showNames: v })), '横排模式生效'),
  ];
}
// 图形 tab:为每个 CLI 指定灯的形状(形状区分 CLI、颜色仍表状态)。
function panelShapes(): HTMLElement[] {
  return [
    field('Claude', shapePicker('claude'), '形状区分是哪个 CLI,灯的颜色仍表示会话状态'),
    field('Codex', shapePicker('codex')),
  ];
}
// 一个「按钮 + 下方说明」单元:按钮名 = 位置名,下方 = 该位置参数说明。自定义项:右键重命名、✕ 删。
function btnUnit(label: string, desc: string, onApply: () => void, onRename?: (v: string) => void, onDelete?: () => void): HTMLElement {
  const unit = el('div', 'pos-unit');
  const top = el('div', 'pos-unit-top');
  const b = el('button', 'btn', label);
  b.onclick = onApply;
  if (onRename) {
    b.title = '点击应用 · 右键重命名';
    b.oncontextmenu = (e) => {
      e.preventDefault();
      startRename(b, label, onRename);
    };
  }
  top.appendChild(b);
  if (onDelete) {
    const del = el('button', 'btn-icon', '✕');
    del.title = '删除';
    del.onclick = onDelete;
    top.appendChild(del);
  }
  unit.appendChild(top);
  unit.appendChild(el('div', 'pos-unit-desc', desc));
  return unit;
}
function panelWindow(): HTMLElement[] {
  // 预设位置:右下/左下/顶部 三个按钮单元
  const presetCtl = el('div', 'pos-units');
  (
    [
      ['br', '右下角', '横排 · 灯下显名 · 宽随灯数(≤6) · Dock 高'],
      ['bl', '左下角', '横排 · 灯下显名 · 宽随灯数(≤6) · Dock 高'],
      ['tc', '顶部中间', '横排 · 不显名 · 宽随灯数(≤6) · 菜单栏高'],
    ] as const
  ).forEach(([k, label, desc]) => presetCtl.appendChild(btnUnit(label, desc, () => api.presetPosition(k))));
  // 自定义位置:每个快照一个按钮单元 + ＋记录
  const customCtl = el('div', 'pos-units');
  cfg.positions.forEach((pos, i) =>
    customCtl.appendChild(btnUnit(pos.name, posDesc(pos), () => api.applyPosition(i), (v) => api.renamePosition(i, v), () => api.deletePosition(i))),
  );
  if (cfg.positions.length < 3) {
    const add = el('button', 'btn', '＋ 记录');
    add.title = '把当前位置/大小/模式记成一个快照';
    add.onclick = () => api.savePosition();
    customCtl.appendChild(add);
  }
  return [field('预设位置', presetCtl), field('自定义位置', customCtl)];
}
// 软件更新:一个按钮随状态变形(检查更新 / 检查中 / 下载中 N% / 重启以更新 / 重试),下方小字说明版本与进度。
function updateControl(): HTMLElement {
  const b = el('button', 'btn');
  if (!upd.supported) {
    b.textContent = '检查更新';
    b.disabled = true; // dev / 非打包版不检查
  } else if (upd.phase === 'checking') {
    b.textContent = '检查中…';
    b.disabled = true;
  } else if (upd.phase === 'available' || upd.phase === 'downloading') {
    b.textContent = `下载中 ${upd.percent ?? 0}%`;
    b.disabled = true;
  } else if (upd.phase === 'ready') {
    b.textContent = `重启以更新到 v${upd.latest}`;
    b.classList.add('primary');
    b.onclick = () => api.installUpdate();
  } else if (upd.phase === 'error') {
    b.textContent = '重试';
    b.onclick = () => api.checkUpdate();
  } else {
    b.textContent = '检查更新';
    b.onclick = () => api.checkUpdate();
  }
  return b;
}
function updateSub(): string {
  const cur = upd.current ? `当前 v${upd.current}` : '';
  if (!upd.supported) return `${cur} · 自动更新仅在打包版生效`;
  switch (upd.phase) {
    case 'checking':
      return `${cur} · 正在检查…`;
    case 'uptodate':
      return `${cur} · 已是最新`;
    case 'available':
    case 'downloading':
      return `发现新版本 v${upd.latest},正在后台下载…`;
    case 'ready':
      return `v${upd.latest} 已下载,点按重启即可完成更新`;
    case 'error':
      return `检查失败:${upd.error || '未知错误'}`;
    default:
      return cur;
  }
}
function panelGeneral(): HTMLElement[] {
  return [
    field('开机自启', checkbox(cfg.launchAtLogin, (v) => api.settingsSet({ launchAtLogin: v })), '登录系统时自动启动 CliPeek'),
    field('菜单栏图标', trayStyleToggle(), '固定图标=单色三盏灯;红绿灯=按当前最紧要的灯着色(切换会自动调整下方数字默认)'),
    field('菜单栏显示数字', checkbox(cfg.trayShowCount, (v) => api.settingsSet({ trayShowCount: v })), '托盘图标旁显示活跃会话数;关掉只留图标'),
    field('软件更新', updateControl(), updateSub()),
  ];
}

// —— 灯语:状态 → 灯效 自定义映射 ——
const FX_STATES: { key: LightStateKey; label: string }[] = [
  { key: 'error', label: '异常' },
  { key: 'needsInput', label: '需介入' },
  { key: 'working', label: '执行中' },
  { key: 'attention', label: '该你了' },
  { key: 'done', label: '完成' },
];
const FX_COLORS: { c: LightColor; label: string }[] = [
  { c: 'red', label: '红' },
  { c: 'amber', label: '黄' },
  { c: 'green', label: '绿' },
  { c: 'off', label: '灭' },
];
function fxColorVar(c: LightColor): string {
  return c === 'red' ? 'var(--dot-r)' : c === 'amber' ? 'var(--dot-y)' : c === 'green' ? 'var(--dot-g)' : '#8e8e93';
}
// 改某状态的灯效:整张表回推(applySettings 用 Object.assign 浅合并 lights 整体)
function setLight(key: LightStateKey, patch: Partial<LightFx>): void {
  api.settingsSet({ lights: { ...cfg.lights, [key]: { ...cfg.lights[key], ...patch } } });
}
// 视觉签名:同色+同闪 = 灯条上无法区分;灭不计(多个隐藏无所谓)
function fxSig(fx: LightFx): string | null {
  if (fx.color === 'off') return null; // 灭不计冲突(多个隐藏无所谓)
  return fx.blink ? `${fx.color}-blink-${fx.blinkMs}` : `${fx.color}-solid`; // 含频率:仅「色+闪+频率」全同才算真·无法区分
}
// 下方说明文字:把当前灯效讲清楚(预览灯 + 这句话一起放在 .field-sub 行)
function lightDesc(fx: LightFx): string {
  if (fx.color === 'off') return '不显示(灯条上暗点占位)';
  const cn = fx.color === 'red' ? '红' : fx.color === 'amber' ? '黄' : '绿';
  return fx.blink ? `${cn} · 闪烁 · ${(fx.blinkMs / 1000).toFixed(1)}s` : `${cn} · 常亮`;
}
function panelLights(): HTMLElement[] {
  // 先统计每种视觉签名被哪些状态共用(查重复)
  const groups = new Map<string, string[]>();
  for (const s of FX_STATES) {
    const g = fxSig(cfg.lights[s.key]);
    if (!g) continue;
    const arr = groups.get(g);
    if (arr) arr.push(s.label);
    else groups.set(g, [s.label]);
  }
  // 复用 .field 表单结构(标签右对齐 + 控件 + 下方说明),与其它 tab 一致
  const rows = FX_STATES.map((s) => {
    const fx = cfg.lights[s.key];
    const usable = fx.color !== 'off';
    const f = el('div', 'field');
    const main = el('div', 'field-main');
    main.appendChild(el('div', 'field-label', s.label));
    const ctl = el('div', 'field-control fx-ctl');
    // 颜色四选(含「灭」);选中的那颗按配置闪 = 实时预览(选中即预览)
    const colors = el('div', 'fx-colors');
    let selSwatch: HTMLElement | null = null;
    for (const { c, label } of FX_COLORS) {
      const on = c === fx.color;
      const sw = el('button', `fx-swatch${on ? ' on' : ''}${c === 'off' ? ' off' : ''}`);
      sw.title = label;
      if (c !== 'off') sw.style.background = fxColorVar(c);
      if (on && fx.blink && usable) {
        sw.classList.add('blink'); // 选中 + 闪 + 非灭 → 自己按频率闪
        sw.style.setProperty('--p-ms', `${fx.blinkMs}ms`);
        selSwatch = sw;
      }
      sw.onclick = () => setLight(s.key, { color: c });
      colors.appendChild(sw);
    }
    ctl.appendChild(colors);
    // 闪烁开关(灭时禁用)
    const blinkBtn = el('button', `fx-blink${fx.blink && usable ? ' on' : ''}`, '闪');
    blinkBtn.disabled = !usable;
    if (usable) blinkBtn.onclick = () => setLight(s.key, { blink: !fx.blink });
    ctl.appendChild(blinkBtn);
    // 频率滑块(仅可闪时启用)
    const slider = el('input', 'fx-slider');
    slider.type = 'range';
    slider.min = String(BLINK_MIN_MS);
    slider.max = String(BLINK_MAX_MS);
    slider.step = '100';
    slider.value = String(fx.blinkMs);
    slider.disabled = !(usable && fx.blink);
    ctl.appendChild(slider);
    main.appendChild(ctl);
    f.appendChild(main);
    // 下方说明行:活预览灯 + 文字(+ 重复警告);与颜色选择器分属不同行,不再混淆
    const sub = el('div', 'field-sub fx-sub');
    const desc = el('span', undefined, lightDesc(fx));
    sub.appendChild(desc);
    const g = fxSig(fx);
    const dup = g ? groups.get(g)! : [];
    if (dup.length > 1) {
      sub.appendChild(el('span', 'fx-warn', `· ⚠ 与「${dup.filter((l) => l !== s.label).join('/')}」相同,无法区分`));
    }
    f.appendChild(sub);
    // 滑块:拖动实时更新「选中颜色点的闪速 + 说明文字」,松手才落库
    slider.oninput = () => {
      const ms = Number(slider.value);
      if (selSwatch) selSwatch.style.setProperty('--p-ms', `${ms}ms`);
      desc.textContent = lightDesc({ ...fx, blinkMs: ms });
    };
    slider.onchange = () => setLight(s.key, { blinkMs: Number(slider.value) });
    return f;
  });
  const resetRow = el('div', 'fx-reset-row');
  const reset = el('button', 'btn', '恢复默认灯语');
  reset.onclick = () => api.settingsSet({ lights: DEFAULT_CONFIG.lights });
  resetRow.appendChild(reset);
  return [...rows, resetRow];
}

// 外壳(标题区 + 标签栏 + 空面板)只建一次;之后切 tab/更新只换面板内容、改标签高亮 —— 不重建整窗,故不抖。
let panelEl: HTMLElement;
const tabBtns = new Map<TabKey, HTMLButtonElement>();
function buildShell(): void {
  const root = document.getElementById('app')!;
  const bar = el('div', 'toolbar');
  tabBtns.clear();
  for (const t of TABS) {
    const b = el('button', 'tab');
    const ic = el('span');
    ic.innerHTML = ICONS[t.key];
    b.appendChild(ic);
    b.appendChild(el('span', undefined, t.label));
    b.onclick = () => switchTab(t.key);
    tabBtns.set(t.key, b);
    bar.appendChild(b);
  }
  panelEl = el('div', 'panel');
  root.replaceChildren(el('div', 'titlebar', 'CliPeek 设置'), bar, panelEl);
}
function switchTab(key: TabKey): void {
  if (key === activeTab) return; // 点当前 tab 不动
  activeTab = key;
  recording = null;
  hintMsg = '';
  renderPanel();
}
// 只重建面板内容(切 tab / 外部 config 变更 / 录快捷键结果都走这里);标题区与标签栏保持不动。
function renderPanel(): void {
  for (const [k, b] of tabBtns) b.classList.toggle('on', k === activeTab);
  const parts =
    activeTab === 'shortcuts'
      ? panelShortcuts()
      : activeTab === 'appearance'
        ? panelAppearance()
        : activeTab === 'lights'
          ? panelLights()
          : activeTab === 'window'
            ? panelWindow()
            : activeTab === 'shapes'
              ? panelShapes()
              : panelGeneral();
  panelEl.replaceChildren(...parts);
  // 同步测高 + 立刻通知主进程 resize(不等 rAF):否则"新内容已显示、窗口还是旧高度"会有 ~16ms 不一致帧 → 抖。
  // 用面板底部位置(= 头部高 + 面板内容高)作为窗口目标高,窗口贴合内容、不留大块空白。
  api.settingsResize(Math.ceil(panelEl.offsetTop + panelEl.offsetHeight));
}

window.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') {
    recording = null;
    renderPanel();
    return;
  }
  const accel = accelFromEvent(e);
  if (!accel) return;
  const other = recording === 'jump' ? cfg.shortcuts.jumpAll : cfg.shortcuts.jump;
  if (accel === other) {
    hintMsg = '两个快捷键不能相同,换一个。';
    renderPanel();
    return;
  }
  cfg = { ...cfg, shortcuts: { ...cfg.shortcuts, [recording]: accel } };
  hintMsg = '';
  api.settingsSet({ shortcuts: cfg.shortcuts });
  recording = null;
  renderPanel();
});

async function init(): Promise<void> {
  cfg = await api.getConfig();
  upd = await api.getUpdateStatus();
  buildShell();
  renderPanel();
  api.onConfig((c) => {
    cfg = c;
    renderPanel();
  });
  api.onUpdateStatus((s) => {
    upd = s;
    if (activeTab === 'general') renderPanel(); // 下载进度推送较频繁,只在「通用」tab 才重渲染
  });
  api.onShortcutResult((r) => {
    if (r.conflict) {
      hintMsg = '⚠️ 快捷键注册失败(可能被系统或其它应用占用),换个组合。';
      renderPanel();
    }
  });
}
init();
