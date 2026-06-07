import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, openSync, readSync, fstatSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { Adapter, Session, SessionState, SessionDetail } from '../../shared/types';
import { isAcknowledged } from '../ack';
import { NOTIFY_DIR, DONE_DIR, FOCUS_DIR } from '../hook';

// ClaudeCodeAdapter:读 ~/.claude/projects/<编码cwd>/<uuid>.jsonl 推断会话状态。
// 状态判断(已用真实日志验证):
//   末块 thinking            → working/thinking
//   末块 tool_use(普通)     → working/executing(工具在跑)
//   末块 tool_use(AskUserQuestion/ExitPlanMode 无结果) → needsInput(阻塞等你回应)
//   末块 text + 文件还在写    → working/replying
//   末块 text + 文件停写      → done(完成·等你)
//   存活靠 pgrep claude + lsof 拿各进程 cwd;cwd 无存活进程 → 该会话 exited。

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const ATTENTION_FRESH_MS = 5 * 60 * 1000; // 刚结束多久内算「该你了」(绿闪)
const ATTENTION_IDLE_MS = 30 * 60 * 1000; // 有 idle_prompt(Claude 在等你)时延长到这么久
const SUBAGENT_FRESH_MS = 30 * 1000; // 子 agent transcript 这么久内写过 → 后台在跑(主对话看着 done 也算执行中)

/** 后台 workflow/子 agent 还在跑?子 agent transcript 写在 <sessionId>/subagents/ 下,
 *  主对话这一轮结束(transcript 不再写)但子 agent 仍在写 → 会话实际在「执行中」。 */
function subagentLatestMtime(dir: string, depth: number): number {
  if (depth > 4) return 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const m = subagentLatestMtime(p, depth + 1);
      if (m > max) max = m;
    } else if (name.endsWith('.jsonl') && st.mtimeMs > max) {
      max = st.mtimeMs;
    }
  }
  return max;
}
function backgroundWorkRunning(jsonlPath: string, now: number): boolean {
  // 注意:不比对主 transcript —— 用户可能边跑 workflow 边在主对话聊天(主 transcript 也在写)。
  // 只看子 agent 最近是否还在写;旧 workflow 的旧文件天然落在窗口外。
  const root = jsonlPath.replace(/\.jsonl$/, '') + '/subagents';
  const latest = subagentLatestMtime(root, 0);
  return latest > 0 && now - latest < SUBAGENT_FRESH_MS;
}
const TAIL_BYTES = 64 * 1024; // 只读文件尾部,避免大文件全读
const HEAD_BYTES = 32 * 1024; // 标题行常在文件开头,尾部找不到就读头部
const LIVENESS_TTL = 4000; // pgrep/lsof 结果缓存时长
// NOTIFY_DIR/DONE_DIR 从 hook.ts 单一来源导入(hook 写、这里读),避免两处各定义一遍路径不同步。
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** 把绝对 cwd 编码成 ~/.claude/projects 下的目录名候选(Claude 把 / 换成 -,可能也换 .)。
 *  用于存活匹配:目录对应「启动 cwd」,与 lsof 拿到的进程 cwd 一致,而会话记录 cwd 可能漂移。 */
function encodeDirs(cwd: string): string[] {
  const a = cwd.replace(/\//g, '-');
  const b = cwd.replace(/[/.]/g, '-');
  return a === b ? [a] : [a, b];
}

/** 项目短名:取 cwd 里最后一个「非隐藏(不以 . 开头)」路径段。
 *  避免会话 cd 进 .obsidian 这类目录时显示成「.obsidian」。 */
function projectName(cwd: string): string {
  const segs = cwd.split('/').filter((s) => s && !s.startsWith('.'));
  return segs[segs.length - 1] || basename(cwd) || cwd;
}

/** 读 Notification hook 的落点:若某会话有「晚于 transcript」的待回应通知 → 返回类型。
 *  permission/question = 硬阻塞(黄闪);idle = Claude 报告在等你输入(软等待,配合新鲜度判 attention)。 */
function readNotify(sessionId: string, transcriptMtime: number, dir = NOTIFY_DIR): 'permission' | 'idle' | null {
  try {
    const p = join(dir, sessionId);
    const st = statSync(p);
    if (st.mtimeMs <= transcriptMtime) return null; // transcript 已往后写 = 已回应
    let type = '';
    try {
      type = readFileSync(p, 'utf8').trim();
    } catch {
      /* 忽略 */
    }
    if (type === 'idle_prompt') return 'idle'; // Claude 空闲等你输入(≥60s)
    if (type === 'permission_prompt') return 'permission'; // 权限/AskUserQuestion 弹窗
    return null; // 未知通知类型不当硬阻塞(AskUserQuestion 等也会被 transcript 的 tool_use 兜住)
  } catch {
    return null; // 没有通知文件
  }
}

/** 读 Stop hook 的落点:Claude 答完一轮(turn 结束)时 hook 写此文件,mtime = 结束时刻。
 *  晚于(或等于)transcript 最后写入 → 这一轮确实结束了——权威信号,不靠尾部是否 end_turn。
 *  解决「末块停在 tool_result / 未 end_turn(被工具收尾)→ 误判执行中(黄)」。
 *  下一轮一开,transcript 写到标记之后 → 标记自动失效,回到尾部判定。 */
function readDone(sessionId: string, transcriptMtime: number, dir = DONE_DIR): boolean {
  try {
    return statSync(join(dir, sessionId)).mtimeMs >= transcriptMtime;
  } catch {
    return false; // 没有 done 文件
  }
}

// 状态信号:用 assistant 消息的 stop_reason 判「是否真完成」,不靠文件新鲜度
// (思考中/等网络时文件不写,但仍是 working)。
type RawKind =
  | { k: 'thinking' }
  | { k: 'text'; endTurn: boolean } // endTurn = stop_reason==='end_turn' → 真完成
  | { k: 'toolUse'; name: string }
  | { k: 'toolResult' }
  | { k: 'userText' }
  | { k: 'error' }; // system.api_error 等异常

interface RawParse {
  cwd: string;
  kind: RawKind | null;
  title: string; // 真实会话标题:customTitle → aiTitle →(空,回退到项目名)
  diag?: string[]; // 仅当 kind 解析不出(null)时填:尾部各行的 type(新→旧),供排查「为什么没解析出状态」
}

function readChunk(path: string, fromEnd: boolean, maxBytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = fromEnd ? Math.max(0, size - maxBytes) : 0;
    const len = Math.min(maxBytes, size - start);
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** 在一段文本里找最后出现的标题(customTitle 优先于 aiTitle)。 */
function scanTitle(text: string): string {
  let custom = '';
  let ai = '';
  for (const line of text.split('\n')) {
    if (!line.includes('-title')) continue; // 快速过滤
    let o: any;
    try {
      o = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
  }
  return custom || ai;
}

// 命令/钩子/系统注入的伪 user 消息(不是真人输入),判状态时要跳过。
// 例:`/compact` 产生的 <local-command-stdout>、斜杠命令、bash 注入、system-reminder 等。
const NOISE_RE = /^\s*<(local-command|command-name|command-message|command-args|bash-|system-reminder|user-prompt-submit-hook)/i;

// 「这一轮已结束」的 stop_reason:除了 end_turn,还有命中停止序列(stop_sequence)、达上限(max_tokens)。
// 只有 tool_use(要调工具)和 null(还在流式输出)才算「未结束/执行中」。
const DONE_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens']);
/** 把一条 assistant/user 记录归类成状态信号;返回 null = 噪声,跳过继续往前找。 */
function classify(o: any): RawKind | null {
  const content = o.message?.content;
  if (o.type === 'assistant') {
    const endTurn = DONE_STOP_REASONS.has(o.message?.stop_reason);
    if (Array.isArray(content) && content.length) {
      const b = content[content.length - 1];
      if (b.type === 'thinking') return { k: 'thinking' };
      if (b.type === 'tool_use') return { k: 'toolUse', name: b.name || '' };
    }
    return { k: 'text', endTurn }; // assistant 的 text(数组或字符串)
  }
  // user
  if (o.isMeta) return null;
  if (Array.isArray(content) && content.length) {
    const b = content[content.length - 1];
    if (b.type === 'tool_result') return { k: 'toolResult' };
    if (b.type === 'text') return NOISE_RE.test(b.text || '') ? null : { k: 'userText' };
    return null;
  }
  if (typeof content === 'string') return NOISE_RE.test(content) ? null : { k: 'userText' };
  return null;
}

/** 扫描文件尾部 maxBytes:最近一条「非噪声」turn 事件 + 准确 cwd。
 *  types:扫到的各行 type(新→旧,封顶 8),仅在 kind 解析不出时用于排查。 */
function scanTail(path: string, maxBytes: number): { cwd: string; kind: RawKind | null; types: string[] } {
  let tail: string;
  try {
    tail = readChunk(path, true, maxBytes);
  } catch {
    return { cwd: '', kind: null, types: [] };
  }
  const lines = tail.split('\n');
  let cwd = '';
  let kind: RawKind | null = null;
  const types: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 尾部首行可能被截断,跳过
    }
    if (types.length < 8) types.push(o.type === 'system' ? `system:${o.subtype || '?'}` : String(o.type || '?'));
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    if (!kind) {
      if (o.type === 'system' && o.subtype === 'api_error') {
        // 自动重试中(retryAttempt < maxRetries)是瞬时态,不判红;只有终态失败才红
        const transient = typeof o.retryAttempt === 'number' && typeof o.maxRetries === 'number' && o.retryAttempt < o.maxRetries;
        if (!transient) kind = { k: 'error' }; // 否则不设 kind,继续往前找真实状态
      } else if ((o.type === 'assistant' || o.type === 'user') && o.message) {
        kind = classify(o);
      }
    }
    if (cwd && kind) break;
  }
  return { cwd, kind, types };
}

/** 从文件尾部解析 cwd + 状态 + 标题。末条记录超大(带图/大文件)时扩读,避免会话被丢。 */
function parseRaw(path: string): RawParse | null {
  let cwd = '';
  let kind: RawKind | null = null;
  let types: string[] = [];
  for (const bytes of [TAIL_BYTES, TAIL_BYTES * 8]) {
    ({ cwd, kind, types } = scanTail(path, bytes)); // 64KB → 512KB:末条巨大时再扩读一次
    if (cwd) break;
  }
  if (!cwd) return null;
  // 标题:尾部找;找不到再读头部(标题常写在会话开头)。
  let title = '';
  try {
    title = scanTitle(readChunk(path, true, TAIL_BYTES));
  } catch {
    /* 忽略 */
  }
  if (!title) {
    try {
      title = scanTitle(readChunk(path, false, HEAD_BYTES));
    } catch {
      /* 忽略 */
    }
  }
  return { cwd, kind, title, diag: kind === null ? types : undefined };
}

/** 状态判定:只有 assistant 末块为 text 且 stop_reason==='end_turn' 才算「完成」;
 *  思考/工具在跑/等工具结果/等网络 一律 working(不靠文件新鲜度,避免思考时误判绿)。 */
function deriveState(kind: RawKind | null): { state: SessionState; detail: SessionDetail } {
  if (!kind) return { state: 'done', detail: 'idle' };
  switch (kind.k) {
    case 'toolUse':
      if (BLOCKING_TOOLS.has(kind.name)) {
        return { state: 'needsInput', detail: kind.name === 'ExitPlanMode' ? 'plan' : 'question' };
      }
      return { state: 'working', detail: 'executing' };
    case 'thinking':
      return { state: 'working', detail: 'thinking' };
    case 'text':
      return kind.endTurn
        ? { state: 'done', detail: 'idle' } // 真·一轮结束,等你
        : { state: 'working', detail: 'replying' }; // 还要继续(后面跟工具/更多内容)
    case 'toolResult':
    case 'userText':
      return { state: 'working', detail: 'executing' };
    case 'error':
      return { state: 'error', detail: 'crashed' };
  }
}

/** 存活进程(pgrep + lsof + ps eww 归一化后的结果)。 */
export interface LiveProc {
  pid: number;
  cwd: string;
  uuid: string | null;
}
/** 一个会话文件的索引项。 */
export interface JsonlRec {
  sid: string;
  path: string;
  dir: string;
  mtimeMs: number;
}

/** 把每个存活进程精确对到「它自己的那个会话」。纯函数(无 I/O),便于单测。
 *   - 精确:进程 uuid → focus 映射的 sid 里取 jsonl mtime 最新且未认领的(同一 tab 先后多会话,活的是最新那个);
 *   - 兜底:无 uuid / focus 没记 → 该进程 cwd 对应目录里取最新且未认领的 jsonl(非 Warp / 老会话)。
 *  返回 sid → pid;显示集 = 它的 key —— 死进程 uuid 不在集中 → 杜绝僵尸,一进程一会话 → 杜绝张冠李戴。 */
export function resolveLiveSessions(
  liveProcs: LiveProc[],
  jsonlBySid: Map<string, JsonlRec>,
  jsonlsByDir: Map<string, JsonlRec[]>,
  sidsByUuid: Map<string, string[]>,
): Map<string, number> {
  const claimed = new Set<string>(); // 已认领 sid
  const pidBySid = new Map<string, number>();
  const claimNewest = (cands: (JsonlRec | undefined)[]): JsonlRec | null => {
    let best: JsonlRec | null = null;
    for (const j of cands) if (j && !claimed.has(j.sid) && (!best || j.mtimeMs > best.mtimeMs)) best = j;
    if (best) claimed.add(best.sid);
    return best;
  };
  const resolveDir = (cwd: string): string | null => {
    for (const d of encodeDirs(cwd)) if (jsonlsByDir.has(d)) return d;
    return null;
  };
  // 先精确认领(免得兜底把精确进程要的 sid 抢走);剩下的进程进第二轮兜底。
  const fallbackProcs: { pid: number; cwd: string }[] = [];
  for (const proc of liveProcs) {
    const picked =
      proc.uuid && sidsByUuid.has(proc.uuid)
        ? claimNewest(sidsByUuid.get(proc.uuid)!.map((sid) => jsonlBySid.get(sid)))
        : null;
    if (picked) pidBySid.set(picked.sid, proc.pid);
    else fallbackProcs.push({ pid: proc.pid, cwd: proc.cwd });
  }
  for (const proc of fallbackProcs) {
    const d = resolveDir(proc.cwd);
    const picked = d ? claimNewest(jsonlsByDir.get(d)!) : null;
    if (picked) pidBySid.set(picked.sid, proc.pid);
  }
  return pidBySid;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly tool = 'claude';
  private cache = new Map<string, { mtimeMs: number; raw: RawParse | null }>();
  // 当前存活 claude 进程:cwd(lsof)+ tab uuid(ps eww 读 WARP_TERMINAL_SESSION_UUID;非 Warp/拿不到为 null)。
  // 用「进程 → 它自己的会话」精确对位替掉旧的「目录最新 N 个」猜测,杜绝僵尸/张冠李戴。
  private liveProcs: { pid: number; cwd: string; uuid: string | null }[] = [];
  private liveTs = 0;
  private diagWarned = new Set<string>(); // 已就「解析不出状态」打过日志的会话 id(每会话每进程只打一次,防刷屏)

  /** pgrep claude → lsof 拿每个进程 cwd + ps eww 拿 tab uuid。带 TTL 缓存。
   *  关键:区分「确实没有 claude 进程」(清空)和「pgrep/lsof 调用本身失败」(保留上次结果,
   *  否则一次偶发失败会让所有会话瞬间判退、列表清空)。uuid 拿不到(非 Warp/ps 失败)→ 该进程走 mtime 兜底。 */
  private refreshLiveness(now: number): void {
    if (now - this.liveTs < LIVENESS_TTL) return;
    this.liveTs = now;

    let pidOut: string;
    try {
      pidOut = execFileSync('pgrep', ['-x', 'claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e: any) {
      if (e && e.status === 1) this.liveProcs = []; // 退出码 1 = 没有匹配进程 = 确实无存活
      return; // 其它错误 = 调用异常 → 保留上次结果
    }
    const pids = pidOut
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => n > 0);
    if (!pids.length) {
      this.liveProcs = [];
      return;
    }
    const pidArg = pids.join(',');

    let lsofOut: string;
    try {
      lsofOut = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', pidArg, '-Fpn'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return; // lsof 异常 → 保留上次结果,避免误判全退出
    }
    // lsof -Fpn:`p<pid>` 后跟 `n<cwd>`(cwd fd 只有一个)。
    const cwdByPid = new Map<number, string>();
    let curPid = 0;
    for (const line of lsofOut.split('\n')) {
      if (line[0] === 'p') curPid = parseInt(line.slice(1), 10) || 0;
      else if (line[0] === 'n' && curPid) cwdByPid.set(curPid, line.slice(1));
    }

    // ps eww 一次取所有进程环境,逐行抠 WARP_TERMINAL_SESSION_UUID(行首是 pid)。
    // 失败=整体走 mtime 兜底,但不影响 cwd(故不 return,uuid 留空即可)。
    const uuidByPid = new Map<number, string>();
    try {
      const psOut = execFileSync('ps', ['eww', '-p', pidArg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of psOut.split('\n')) {
        const pm = line.match(/^\s*(\d+)\s/);
        const um = line.match(/WARP_TERMINAL_SESSION_UUID=([0-9a-f]+)/);
        if (pm && um) uuidByPid.set(parseInt(pm[1], 10), um[1]);
      }
    } catch {
      /* uuid 拿不到 → 全走 mtime 兜底 */
    }

    const procs: { pid: number; cwd: string; uuid: string | null }[] = [];
    for (const pid of pids) {
      const cwd = cwdByPid.get(pid);
      if (!cwd) continue; // lsof 没给到 cwd(极少)→ 跳过
      procs.push({ pid, cwd, uuid: uuidByPid.get(pid) ?? null });
    }
    this.liveProcs = procs;
  }

  poll(): Session[] {
    const now = Date.now();
    this.refreshLiveness(now);
    if (!this.liveProcs.length) {
      this.cache.clear(); // 无存活进程 → 啥也不显示
      return [];
    }

    // ① 索引所有会话文件:sid → {path,dir,mtime};dir → 按 mtime 降序的 [J](供 uuid 平局/兜底取最新)。
    type J = { sid: string; path: string; dir: string; mtimeMs: number };
    const jsonlBySid = new Map<string, J>();
    const jsonlsByDir = new Map<string, J[]>();
    let dirs: string[] = [];
    try {
      dirs = readdirSync(PROJECTS_DIR);
    } catch {
      return [];
    }
    for (const d of dirs) {
      let files: string[] = [];
      try {
        files = readdirSync(join(PROJECTS_DIR, d));
      } catch {
        continue;
      }
      const arr: J[] = [];
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const path = join(PROJECTS_DIR, d, f);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        const rec: J = { sid: f.replace(/\.jsonl$/, ''), path, dir: d, mtimeMs };
        arr.push(rec);
        jsonlBySid.set(rec.sid, rec); // sid = uuid 文件名,全局唯一,跨目录不撞
      }
      if (arr.length) {
        arr.sort((a, b) => b.mtimeMs - a.mtimeMs);
        jsonlsByDir.set(d, arr);
      }
    }

    // ② focus 文件:tab uuid → 该 tab 跑过的会话 sid(可能多个:同一 tab 先后开多个会话,老的 focus 残留)。
    const sidsByUuid = new Map<string, string[]>();
    try {
      for (const f of readdirSync(FOCUS_DIR)) {
        let url = '';
        try {
          url = readFileSync(join(FOCUS_DIR, f), 'utf8').trim();
        } catch {
          continue;
        }
        const m = url.match(/session\/([0-9a-f]+)/i);
        if (m) (sidsByUuid.get(m[1]) ?? sidsByUuid.set(m[1], []).get(m[1])!).push(f);
      }
    } catch {
      /* 无 focus 目录 → 全走 mtime 兜底 */
    }

    // ③ 每个存活进程精确对到「它自己的会话」(纯逻辑抽到 resolveLiveSessions,已单测)。
    const pidBySid = resolveLiveSessions(this.liveProcs, jsonlBySid, jsonlsByDir, sidsByUuid);

    // ④ 认领到的 sid = 要显示的存活会话:解析 + 缓存。
    type Entry = { path: string; id: string; mtimeMs: number; raw: RawParse; pid: number };
    const entries: Entry[] = [];
    const seenPaths = new Set<string>();
    for (const [sid, pid] of pidBySid) {
      const j = jsonlBySid.get(sid)!;
      seenPaths.add(j.path);
      const cached = this.cache.get(j.path);
      let raw: RawParse | null;
      if (cached && cached.mtimeMs === j.mtimeMs) raw = cached.raw;
      else {
        raw = parseRaw(j.path);
        // 解析失败(末条超大/截断)但上次解过 → 沿用,别让会话凭空消失
        if ((!raw || !raw.cwd) && cached?.raw?.cwd) raw = cached.raw;
        this.cache.set(j.path, { mtimeMs: j.mtimeMs, raw });
      }
      if (raw && raw.cwd) entries.push({ path: j.path, id: sid, mtimeMs: j.mtimeMs, raw, pid });
    }
    // 清理缓存:只保留本轮见过的路径(否则删掉/轮转的 transcript 会无限堆积)
    for (const k of this.cache.keys()) if (!seenPaths.has(k)) this.cache.delete(k);

    // ⑤ 逐个定状态(精确对位后无需再按目录分组;最终排序在 main 的 namedSessions 做)。
    const out: Session[] = [];
    for (const e of entries) {
      // 排查用:活进程但末尾解析不出任何 turn 信号(kind=null,deriveState 会回退成 done)。
      // 不改判定、只暴露真实样本——出现时把这行日志贴出来,据尾部行类型把 classify 补全(而非靠显色糊弄)。
      if (e.raw.kind === null && !this.diagWarned.has(e.id)) {
        this.diagWarned.add(e.id);
        console.warn(
          `[clipeek] 活会话状态解析不出(回退 done,疑似误判): id=${e.id} cwd=${e.raw.cwd} 尾部行类型(新→旧)=[${(e.raw.diag || []).join(', ')}]`,
        );
      }
      const notify = readNotify(e.id, e.mtimeMs); // 待回应通知(晚于 transcript)
      let state: SessionState;
      let detail: SessionDetail;
      if (notify === 'permission') {
        state = 'needsInput'; // 硬阻塞 → 黄闪
        detail = 'permission';
      } else {
        ({ state, detail } = deriveState(e.raw.kind));
        // 权威 turn-end 信号:Stop hook 写的 done 标记晚于 transcript → 这一轮真结束了,
        // 哪怕尾部停在 tool_result / 未 end_turn(被工具收尾等)也强制完成。只升级 working,
        // 不动 needsInput(AskUserQuestion/ExitPlanMode 在等你,Stop 不会触发)/error。
        if (state === 'working' && readDone(e.id, e.mtimeMs)) {
          state = 'done';
          detail = 'idle';
        }
        // 完成态再细分:刚结束(新鲜)或 Claude 报告在等你(idle)→ attention(绿闪·该你了);超时则休眠绿。
        if (state === 'done') {
          const age = now - e.mtimeMs;
          const win = notify === 'idle' ? ATTENTION_IDLE_MS : ATTENTION_FRESH_MS;
          // 用户已打开过该 tab(且此后无新活动)→ 不再绿闪;有新一轮活动会自动恢复闪。
          if (age < win && !isAcknowledged(e.id, e.mtimeMs)) {
            state = 'attention';
            detail = 'idle';
          }
        }
        // 看着 done/绿闪,但后台 workflow/子 agent 还在跑 → 其实在执行中(黄)
        if ((state === 'done' || state === 'attention') && backgroundWorkRunning(e.path, now)) {
          state = 'working';
          detail = 'executing';
        }
      }
      const display = e.raw.title || projectName(e.raw.cwd); // 默认 name=真实标题,退而取项目名
      out.push({
        id: e.id,
        tool: 'claude',
        cwd: e.raw.cwd, // 完整路径(列表第二列用)
        name: display, // 点标签 + 列表第一列;可被 config.names 本地改名覆盖
        title: display,
        state,
        detail,
        lastActivity: e.mtimeMs,
        pid: e.pid, // 精确对位后这就是该会话真实进程的 pid(双击聚焦 ps eww 兜底也准)
      });
    }
    return out;
  }
}

// 暴露纯逻辑给单元测试(仅供 *.test.ts 导入,运行时主流程不依赖这些再导出)。
export { classify, deriveState, scanTitle, scanTail, parseRaw, readNotify, readDone, encodeDirs, projectName };
export type { RawKind };
