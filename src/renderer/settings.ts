import type { Config } from '../shared/types';
import { DEFAULT_CONFIG, SCALE_MIN, SCALE_MAX } from '../shared/types';
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
  general:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};
const TABS = [
  { key: 'shortcuts', label: '快捷键' },
  { key: 'appearance', label: '外观' },
  { key: 'window', label: '窗口' },
  { key: 'general', label: '通用' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

let cfg: Config = DEFAULT_CONFIG;
let activeTab: TabKey = 'shortcuts';
let recording: 'jump' | 'jumpAll' | null = null;
let hintMsg = '';

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
function resetBtn(label: string, action: string): HTMLElement {
  const b = el('button', 'btn', label);
  b.onclick = () => api.settingsAction(action);
  return b;
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
function panelAppearance(): HTMLElement[] {
  return [
    field('缩放', stepper()),
    field('布局', layoutToggle()),
    field('灯下显示名字', checkbox(cfg.showNames, (v) => api.settingsSet({ showNames: v })), '横排模式生效'),
  ];
}
function panelWindow(): HTMLElement[] {
  return [
    field('位置', resetBtn('重置', 'resetPosition'), '移回当前屏右下角'),
    field('大小', resetBtn('恢复默认', 'resetSize'), '宽高与缩放恢复默认'),
  ];
}
function panelGeneral(): HTMLElement[] {
  return [field('开机自启', checkbox(cfg.launchAtLogin, (v) => api.settingsSet({ launchAtLogin: v })), '登录系统时自动启动 CliPeek')];
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
        : activeTab === 'window'
          ? panelWindow()
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
  buildShell();
  renderPanel();
  api.onConfig((c) => {
    cfg = c;
    renderPanel();
  });
  api.onShortcutResult((r) => {
    if (r.conflict) {
      hintMsg = '⚠️ 快捷键注册失败(可能被系统或其它应用占用),换个组合。';
      renderPanel();
    }
  });
}
init();
