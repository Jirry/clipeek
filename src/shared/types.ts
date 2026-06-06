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

/** 持久化配置(写在 userData 下的 config.json)。 */
export interface Config {
  x: number | null;
  y: number | null;
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
}

/** UI 缩放安全范围 —— 单一来源:sanitize 的越界夹持(store.ts)与菜单放大/缩小的边界(main.ts)共用。 */
export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2.0;

export const DEFAULT_CONFIG: Config = {
  x: null,
  y: null,
  scale: 1,
  width: null,
  height: null,
  listWidth: null,
  listHeight: null,
  layout: 'bar',
  showNames: true,
  names: {},
};

/** Adapter 统一接口:轮询返回当前所有会话。ClaudeCodeAdapter / CodexAdapter / MockAdapter 都实现它。 */
export interface Adapter {
  readonly tool: string;
  poll(): Promise<Session[]> | Session[];
}
