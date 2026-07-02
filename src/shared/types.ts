// clipeek 的核心数据模型。Adapter 把各家 CLI 的会话归一化成 Session,
// 渲染层只认 Session,不关心数据来自 Claude Code 还是 Codex。

/**
 * 会话状态 —— 对应红绿灯灯语:
 * - error      🔴 红·常亮  异常:工具报错 / 进程崩溃
 * - needsInput 🟡 黄·闪烁  需要人为介入(硬阻塞):权限确认 / AskUserQuestion / 计划审批
 * - attention  🟢 绿·闪烁  完成·该你了:刚结束 / Claude 报告在等你输入(软等待,需感知)
 * - working    🟡 黄·常亮  执行中:思考 / 跑命令 / 流式回复(agent 在动)
 * - done       🟢 绿·常亮  完成·休眠:很久前结束、已搁置
 * - exited     ⚪ 灰·灭    已退出:正常收工、进程没了
 */
export type SessionState = 'done' | 'working' | 'needsInput' | 'attention' | 'error' | 'exited';

/** 子状态:角标只看 state,展开面板用 detail 显示「具体在忙什么」。 */
export type SessionDetail =
  | 'thinking'
  | 'executing'
  | 'replying'
  | 'permission'
  | 'question'
  | 'plan'
  | 'idle'
  | 'crashed'
  | null;

export interface Session {
  id: string;
  tool: 'claude' | 'codex' | string;
  cwd: string;
  /** 点下方的短标签,默认取 cwd 末段(项目名)。 */
  name: string;
  /** 展开列表里的真实会话标题(customTitle→aiTitle→项目名)。重命名会同时覆盖 name 和 title。 */
  title: string;
  state: SessionState;
  detail: SessionDetail;
  /** epoch ms,最近一次活动时间,用于「计时」和判活。 */
  lastActivity: number;
  pid?: number;
}

/** 状态优先级:数字越小越靠前。排序:红(异常)▸黄闪(待介入)▸黄(执行)▸绿闪(该你了)▸绿(休眠)▸灰(退出)。 */
export const STATE_PRIORITY: Record<SessionState, number> = {
  error: 0,
  needsInput: 1,
  working: 2,
  attention: 3,
  done: 4,
  exited: 5,
};

/** 一份位置快照:记录「一键还原」所需的全部位置/大小/模式字段(预设也复用它的应用逻辑)。 */
export interface SavedPosition {
  name: string;
  layout: 'bar' | 'list';
  scale: number;
  showNames: boolean;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  listWidth: number | null;
  listHeight: number | null;
  dockRight: boolean;
  dockBottom: boolean;
  topCenter: boolean;
}

/** 灯的颜色;'off' = 灭(灯条上画暗点占位,不抢眼但不让人以为会话没了)。 */
export type LightColor = 'red' | 'amber' | 'green' | 'off';

/** 一种灯效:颜色 + 是否闪烁 + 闪烁周期(ms,仅 blink=true 时生效)。 */
export interface LightFx {
  color: LightColor;
  blink: boolean;
  blinkMs: number;
}

/** 可被用户自定义灯效的会话状态(exited=灯消失,不参与映射)。 */
export type LightStateKey = 'error' | 'needsInput' | 'working' | 'attention' | 'done';

/** 持久化配置(写在 userData 下的 config.json)。 */
export interface Config {
  /** 上次窗口左上角(仅用于「上次在哪块屏」的定位;贴边落点由 dockRight/dockBottom + 当前宽高实时算)。 */
  x: number | null;
  y: number | null;
  /** 横排状态条上次贴的角:右/左、下/上。状态条宽随会话数自适应,故贴边语义用「边」而非绝对坐标。 */
  dockRight: boolean;
  dockBottom: boolean;
  /** UI 缩放,1 = 默认大小,满足「大小可调」。 */
  scale: number;
  /** 用户拖边缘设定的窗口宽度;null = 自适应内容宽度。 */
  width: number | null;
  /** 用户拖顶边设定的状态条高度;null = 默认贴合 Dock 高(× scale)。 */
  height: number | null;
  /** 竖排列表窗用户拖拽设定的宽度;null = 默认(取状态条内容宽)。 */
  listWidth: number | null;
  /** 竖排列表窗用户拖拽设定的高度;null = 自适应内容(带上限)。 */
  listHeight: number | null;
  /** 布局:'bar' 横排点阵(默认) / 'list' 竖排列表。 */
  layout: 'bar' | 'list';
  /** 横排模式下是否在圆灯下显示名字(默认 true,圆灯下显示名字;关掉则只显点、名字靠悬停)。 */
  showNames: boolean;
  /** 自定义重命名:sessionId -> 显示名。 */
  names: Record<string, string>;
  /** 全局快捷键(Electron accelerator 字符串)。jump = 智能跳转,jumpAll = 全量循环。 */
  shortcuts: { jump: string; jumpAll: string };
  /** 登录系统时自动启动 CliPeek。 */
  launchAtLogin: boolean;
  /** 顶部居中预设:贴菜单栏下沿、整屏水平居中。用户一拖动就取消(回到 dockRight/dockBottom 贴角)。 */
  topCenter: boolean;
  /** 自定义位置快照(用户记录的位置/大小/模式,一键还原),最多 3 个。 */
  positions: SavedPosition[];
  /** 状态→灯效 自定义映射(用户可改);默认见 DEFAULT_CONFIG.lights。 */
  lights: Record<LightStateKey, LightFx>;
  /** 菜单栏托盘图标样式:'icon'=单色三盏灯固定图标 / 'lights'=按「第一个灯」状态着色的红绿灯点。 */
  trayStyle: 'icon' | 'lights';
  /** 菜单栏图标旁是否显示活跃会话数。默认随样式(红绿灯→显示、固定图标→不显);用户可单独覆盖。 */
  trayShowCount: boolean;
}

/** UI 缩放安全范围 —— 单一来源:sanitize 的越界夹持(store.ts)与菜单放大/缩小的边界(main.ts)共用。 */
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2.0;

/** 闪烁周期(ms)安全范围 —— sanitize 夹持与设置滑块共用(0.5s–2.0s)。 */
export const BLINK_MIN_MS = 500;
export const BLINK_MAX_MS = 2000;

/** 默认全局快捷键。 */
export const DEFAULT_SHORTCUTS = { jump: 'Command+J', jumpAll: 'Command+Shift+J' };

export const DEFAULT_CONFIG: Config = {
  x: null,
  y: null,
  dockRight: true, // 默认贴右下角
  dockBottom: true,
  scale: 1,
  width: null,
  height: null,
  listWidth: null,
  listHeight: null,
  layout: 'bar',
  showNames: true,
  names: {},
  shortcuts: { ...DEFAULT_SHORTCUTS },
  launchAtLogin: false,
  topCenter: false,
  positions: [],
  lights: {
    error: { color: 'red', blink: false, blinkMs: 1200 }, // 异常:红
    needsInput: { color: 'red', blink: true, blinkMs: 800 }, // 需介入:红闪
    working: { color: 'amber', blink: false, blinkMs: 1200 }, // 执行中:黄
    attention: { color: 'green', blink: true, blinkMs: 1200 }, // 该你了:绿闪
    done: { color: 'off', blink: false, blinkMs: 1200 }, // 完成:暗点占位
  },
  trayStyle: 'icon',
  trayShowCount: false, // 默认固定图标 → 不显数字(切到红绿灯样式会联动开启)
};

/** Adapter 统一接口:轮询返回当前所有会话。ClaudeCodeAdapter / CodexAdapter / MockAdapter 都实现它。 */
export interface Adapter {
  readonly tool: string;
  poll(): Promise<Session[]> | Session[];
}

/** 自动更新的运行时状态(主进程 → 设置窗推送 / 托盘刷新;不持久化)。 */
export interface UpdateStatus {
  /** idle 初始 · checking 查询中 · uptodate 已最新 · available 发现新版 · downloading 下载中 · ready 已就绪待重启 · error 出错 */
  phase: 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'error';
  /** 当前运行版本(app.getVersion())。 */
  current: string;
  /** 最新版本号(已去掉前缀 v);发现新版后才有值。 */
  latest?: string;
  /** 下载进度 0–100。 */
  percent?: number;
  /** 出错信息(phase=error)。 */
  error?: string;
  /** 是否支持自动更新:仅打包后的 macOS 为 true(dev / 其它平台 false,只显示版本号)。 */
  supported: boolean;
}
