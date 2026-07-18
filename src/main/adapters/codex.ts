import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, openSync, readSync, fstatSync, closeSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { Adapter, Session, SessionState, SessionDetail } from '../../shared/types';
import { isAcknowledged } from '../ack';

// CodexAdapter:读 ~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl 推断交互式 CLI 会话状态。
// 只显示交互式 CLI(session_meta.source==='cli' / originator codex-tui);桌面(vscode)、一次性(exec)、子 agent 排除。
// 状态判断(已按真实样本枚举,见 memory clipeek-codex-research):Codex 用显式 turn 边界事件,
//   末尾 event_msg task_complete / turn_aborted → done(等你);error → error;
//   task_started / (agent_)reasoning → working·思考;agent_message / assistant message → working·回复;
//   exec_command_end / patch_apply_end / mcp/web / function_call / custom_tool_call → working·执行中。
//   噪声跳过:token_count / thread_name_updated / context_compacted。
// 解析不许糊弄:末条超大(>64KB)时扩读一次;尾部一行都解不出(截断)则沿用上次状态、并打诊断日志按真实样本补 classify。
// 判活:ps 枚举 codex 进程(排 app-server/mcp/exec)+ lsof 拿 cwd → 对到 source=cli 且 cwd 匹配的最新 rollout。
// ⚠️ needsInput(等你批准)判不出:approval 是交互态不写 rollout → 等批准时显示为 working·执行中(v1 已知取舍)。

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const TAIL_BYTES = 64 * 1024; // 先读这么多尾部
const TAIL_MAX_BYTES = TAIL_BYTES * 8; // 末条记录超大(大文件/粘图/长输出)时扩读上限 512KB(镜像 claude 的 parseRaw)
const HEAD_BYTES = 32 * 1024; // 标题事件可能在文件前段
const LIVENESS_TTL = 4000; // ps/lsof 结果缓存时长
const ATTENTION_FRESH_MS = 5 * 60 * 1000; // 刚结束多久内算「该你了」(绿闪)
const RECENT_DAY_DIRS = 7; // 只扫最近 N 个 YYYY/MM/DD 目录:交互会话的 rollout 几乎都在近几天(且桌面应用会回写老文件,mtime 不可信)

/** 项目短名:取 cwd 里最后一个非隐藏路径段(同 claude 适配器,保持一致的显示语义)。 */
function projectName(cwd: string): string {
  const segs = cwd.split('/').filter((s) => s && !s.startsWith('.'));
  return segs[segs.length - 1] || basename(cwd) || cwd;
}

/** 规范化 cwd 供对位:解析符号链接(如 /tmp→/private/tmp)+ 去尾斜杠;路径已不存在则用原值。
 *  避免「lsof 拿到的进程 cwd」与「session_meta.cwd」因符号链接/斜杠差异对不上导致活会话不显示。 */
function normCwd(p: string): string {
  let s = p;
  try {
    s = realpathSync(p);
  } catch {
    /* 路径可能已删除 → 退回原值 */
  }
  return s.replace(/\/+$/, '') || '/';
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

/** 最近 N 个 sessions/YYYY/MM/DD 目录(按名倒序取新)。 */
function recentDayDirs(root: string, maxDays: number): string[] {
  const safe = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  const out: string[] = [];
  for (const y of safe(root).filter((d) => /^\d{4}$/.test(d)).sort().reverse()) {
    for (const m of safe(join(root, y)).filter((d) => /^\d{2}$/.test(d)).sort().reverse()) {
      for (const d of safe(join(root, y, m)).filter((d) => /^\d{2}$/.test(d)).sort().reverse()) {
        out.push(join(root, y, m, d));
        if (out.length >= maxDays) return out;
      }
    }
  }
  return out;
}

// 状态信号:Codex 的 turn 边界/子事件归一。
export type CodexKind = 'done' | 'error' | 'thinking' | 'replying' | 'executing' | 'user';

/** 把一行 record 归类成状态信号;返回 null = 噪声(token_count/标题/压缩/meta 等),跳过继续往前找。 */
export function classify(o: any): CodexKind | null {
  if (o?.type === 'event_msg') {
    switch (o.payload?.type) {
      case 'task_complete':
      case 'turn_aborted':
        return 'done';
      case 'error':
        return 'error';
      case 'task_started':
      case 'agent_reasoning':
        return 'thinking';
      case 'agent_message':
        return 'replying';
      case 'exec_command_end':
      case 'patch_apply_end':
      case 'mcp_tool_call_end':
      case 'web_search_end':
        return 'executing';
      case 'user_message':
        return 'user';
      default:
        return null; // token_count / thread_name_updated / context_compacted / ...
    }
  }
  if (o?.type === 'response_item') {
    switch (o.payload?.type) {
      case 'reasoning':
        return 'thinking';
      case 'function_call':
      case 'function_call_output':
      case 'custom_tool_call':
      case 'custom_tool_call_output':
      case 'web_search_call':
        return 'executing';
      case 'message': {
        const role = o.payload?.role;
        if (role === 'assistant') return 'replying';
        if (role === 'user') return 'user';
        return null; // developer / system(会话开头的注入,非状态信号)
      }
      default:
        return null;
    }
  }
  return null; // session_meta / turn_context
}

/** 尾部最近一条非噪声信号 → 状态。turn 已结束(done)/报错时按其判;进行中的各子事件都算 working。 */
export function deriveState(kind: CodexKind | null): { state: SessionState; detail: SessionDetail } {
  switch (kind) {
    case null:
    case 'done':
      return { state: 'done', detail: 'idle' }; // 无信号(刚开会话没 turn)也当「等你」
    case 'error':
      return { state: 'error', detail: 'crashed' };
    case 'thinking':
      return { state: 'working', detail: 'thinking' };
    case 'replying':
      return { state: 'working', detail: 'replying' };
    case 'executing':
    case 'user':
      return { state: 'working', detail: 'executing' };
  }
}

/** 在一段文本里找最后出现的会话标题(thread_name_updated.thread_name)。 */
function scanName(text: string): string {
  let name = '';
  for (const line of text.split('\n')) {
    if (!line.includes('thread_name_updated')) continue; // 快速过滤
    let o: any;
    try {
      o = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (o.payload?.type === 'thread_name_updated' && o.payload.thread_name) name = o.payload.thread_name;
  }
  return name;
}

export interface TailParse {
  kind: CodexKind | null;
  name: string;
  types: string[]; // 尾部各行类型(新→旧,封顶 8);仅供 kind 解不出时排查
  parsedLines: number; // 尾部成功 JSON.parse 的行数(=0 说明整段截断、不可信)
}

/** 扫描一段尾部文本:最近一条非噪声信号 + 标题 + 诊断信息。 */
function scanTail(path: string, maxBytes: number): TailParse {
  let tail: string;
  try {
    tail = readChunk(path, true, maxBytes);
  } catch {
    return { kind: null, name: '', types: [], parsedLines: 0 };
  }
  const lines = tail.split('\n');
  let kind: CodexKind | null = null;
  let name = '';
  let parsedLines = 0;
  const types: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 尾部首行可能被截断
    }
    parsedLines++;
    if (types.length < 8) {
      types.push(o.type === 'event_msg' ? `event:${o.payload?.type || '?'}` : o.type === 'response_item' ? `resp:${o.payload?.type || '?'}` : String(o.type || '?'));
    }
    if (!name && o.type === 'event_msg' && o.payload?.type === 'thread_name_updated' && o.payload.thread_name) {
      name = o.payload.thread_name; // 最靠尾的先命中 = 最新
    }
    if (!kind) {
      const k = classify(o);
      if (k) kind = k;
    }
    if (kind && name) break;
  }
  return { kind, name, types, parsedLines };
}

/** 从文件尾部解析状态 + 标题。末条记录超大时 64KB 尾部只剩截断片 → 扩读一次(镜像 claude)。标题尾部找不到再读头部。 */
export function parseTail(path: string): TailParse {
  let r = scanTail(path, TAIL_BYTES);
  if (r.kind === null) {
    const bigger = scanTail(path, TAIL_MAX_BYTES); // 末条超大 → 扩到 512KB 再试
    if (bigger.kind !== null || bigger.parsedLines > r.parsedLines) r = bigger;
  }
  if (!r.name) {
    try {
      r = { ...r, name: scanName(readChunk(path, false, HEAD_BYTES)) };
    } catch {
      /* 忽略 */
    }
  }
  return r;
}

interface Meta {
  cwd: string; // 原始 cwd(展示用)
  ncwd: string; // 归一化 cwd(对位用)
  source: string;
  sid: string;
}

export class CodexAdapter implements Adapter {
  readonly tool = 'codex';
  // 存活的交互式 codex 进程:pid + 归一化 cwd。codex 无 Warp uuid/focus 可用,只能靠 cwd 对位。
  private liveProcs: { pid: number; ncwd: string }[] = [];
  private liveTs = 0;
  private metaCache = new Map<string, Meta | null>(); // session_meta 不可变 → 按 path 缓存(每轮按本轮扫到的裁剪)
  private stateCache = new Map<string, { mtimeMs: number; kind: CodexKind | null; name: string; types: string[] }>();
  private diagWarned = new Set<string>(); // 已就「解析不出状态」打过日志的会话 id(每会话一次,防刷屏)

  /** ps 枚举 codex 进程 → 排除 app-server/mcp/exec(非交互)→ lsof 拿各进程 cwd。带 TTL 缓存。
   *  区分「确实没有交互 codex」(清空)与「ps/lsof 调用失败」(保留上次),避免偶发失败把会话全判退。 */
  private refreshLiveness(now: number): void {
    if (now - this.liveTs < LIVENESS_TTL) return;
    this.liveTs = now;

    let psOut: string;
    try {
      psOut = execFileSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return; // ps 异常 → 保留上次结果
    }
    const pids: number[] = [];
    for (const line of psOut.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/); // pid + comm(可能是完整路径,取基名)
      if (m && basename(m[2].trim()) === 'codex') pids.push(parseInt(m[1], 10));
    }
    if (!pids.length) {
      this.liveProcs = [];
      return;
    }

    // 全命令行:排除 `codex app-server`(Cursor 扩展后台)/ `codex mcp` / `codex exec`(一次性),只留交互式 TUI。
    // 正则锚定到 codex 二进制名之后的第一个 token(^ 或 /codex),避免误伤 prompt 里恰含「codex exec」等词的交互会话。
    let cmdOut: string;
    try {
      cmdOut = execFileSync('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return;
    }
    const keep: number[] = [];
    for (const line of cmdOut.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      if (/(?:^|\/)codex\s+(app-server|mcp|exec)\b/.test(m[2])) continue; // 非交互子命令 → 排除
      keep.push(parseInt(m[1], 10));
    }
    if (!keep.length) {
      this.liveProcs = [];
      return;
    }

    let lsofOut: string;
    try {
      lsofOut = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', keep.join(','), '-Fpn'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return;
    }
    const cwdByPid = new Map<number, string>();
    let curPid = 0;
    for (const line of lsofOut.split('\n')) {
      if (line[0] === 'p') curPid = parseInt(line.slice(1), 10) || 0;
      else if (line[0] === 'n' && curPid) cwdByPid.set(curPid, line.slice(1));
    }
    const procs: { pid: number; ncwd: string }[] = [];
    for (const pid of keep) {
      const cwd = cwdByPid.get(pid);
      if (cwd) procs.push({ pid, ncwd: normCwd(cwd) });
    }
    this.liveProcs = procs;
  }

  /** 读 session_meta(首行,不可变)→ cwd/source/sid;按 path 缓存。 */
  private meta(path: string): Meta | null {
    if (this.metaCache.has(path)) return this.metaCache.get(path)!;
    let m: Meta | null = null;
    try {
      const firstLine = readChunk(path, false, HEAD_BYTES).split('\n', 1)[0];
      const o = JSON.parse(firstLine);
      if (o?.type === 'session_meta' && o.payload) {
        const cwd = o.payload.cwd || '';
        m = { cwd, ncwd: cwd ? normCwd(cwd) : '', source: o.payload.source || '', sid: o.payload.session_id || basename(path).replace(/\.jsonl$/, '') };
      }
    } catch {
      /* 首行不是合法 session_meta → 记为 null 缓存,不再重试 */
    }
    this.metaCache.set(path, m);
    return m;
  }

  private stateOf(path: string, mtimeMs: number): { kind: CodexKind | null; name: string; types: string[] } {
    const c = this.stateCache.get(path);
    if (c && c.mtimeMs === mtimeMs) return { kind: c.kind, name: c.name, types: c.types };
    const r = parseTail(path);
    let kind = r.kind;
    let name = r.name;
    // 尾部一行都没解析出来(整段截断)→ 别降级成 done 糊弄绿闪,沿用上次已知状态(镜像 claude「解析失败沿用上次」)。
    if (kind === null && r.parsedLines === 0 && c && c.kind !== null) {
      kind = c.kind;
      name = name || c.name;
    }
    this.stateCache.set(path, { mtimeMs, kind, name, types: r.types });
    return { kind, name, types: r.types };
  }

  poll(): Session[] {
    const now = Date.now();
    this.refreshLiveness(now);
    if (!this.liveProcs.length) return [];

    // ① 索引最近几天的 cli rollout:归一化 cwd → [{sid,path,cwd,mtime}]。
    type R = { sid: string; path: string; cwd: string; mtimeMs: number };
    const byNcwd = new Map<string, R[]>();
    const seenCliPaths = new Set<string>(); // 本轮认领到的 cli 会话文件(裁 stateCache)
    const scannedPaths = new Set<string>(); // 本轮扫到的所有 rollout(含非 cli,裁 metaCache)
    for (const dir of recentDayDirs(SESSIONS_DIR, RECENT_DAY_DIRS)) {
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
        const path = join(dir, f);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        scannedPaths.add(path);
        const m = this.meta(path);
        if (!m || m.source !== 'cli' || !m.ncwd) continue; // 只要交互式 CLI
        seenCliPaths.add(path);
        const rec: R = { sid: m.sid, path, cwd: m.cwd, mtimeMs };
        (byNcwd.get(m.ncwd) ?? byNcwd.set(m.ncwd, []).get(m.ncwd)!).push(rec);
      }
    }

    // ② 每个存活进程 → 同(归一化)cwd 下最新且未认领的 rollout(镜像 claude 的 cwd 兜底对位)。
    const claimed = new Set<string>();
    const matched: { rec: R; pid: number }[] = [];
    for (const proc of this.liveProcs) {
      const cands = byNcwd.get(proc.ncwd);
      if (!cands) continue;
      let best: R | null = null;
      for (const r of cands) if (!claimed.has(r.sid) && (!best || r.mtimeMs > best.mtimeMs)) best = r;
      if (best) {
        claimed.add(best.sid);
        matched.push({ rec: best, pid: proc.pid });
      }
    }

    // ③ 逐个解析尾部定状态。
    const out: Session[] = [];
    for (const { rec, pid } of matched) {
      const { kind, name, types } = this.stateOf(rec.path, rec.mtimeMs);
      // 排查用:活会话尾部解析不出任何 turn 信号(kind=null → deriveState 回退 done)。
      // 不改判定、只暴露真实样本 —— 出现时把日志贴出来,据尾部行类型把 classify 补全(而非靠显色糊弄)。
      if (kind === null && !this.diagWarned.has(rec.sid)) {
        this.diagWarned.add(rec.sid);
        console.warn(`[clipeek] codex 活会话状态解析不出(回退 done,疑似误判): id=${rec.sid} cwd=${rec.cwd} 尾部行类型(新→旧)=[${types.join(', ')}]`);
      }
      let { state, detail } = deriveState(kind);
      // 完成态且新鲜、未被认领(双击聚焦过)→ attention(绿闪·该你了)
      if (state === 'done' && now - rec.mtimeMs < ATTENTION_FRESH_MS && !isAcknowledged(rec.sid, rec.mtimeMs)) {
        state = 'attention';
        detail = 'idle';
      }
      const display = name || projectName(rec.cwd);
      out.push({
        id: rec.sid,
        tool: 'codex',
        cwd: rec.cwd,
        name: display,
        title: display,
        state,
        detail,
        lastActivity: rec.mtimeMs,
        pid,
      });
    }

    // 裁剪缓存:stateCache 只留本轮认领到的 cli 文件;metaCache 只留本轮扫到的(含非 cli,免下轮重读)。
    for (const k of this.stateCache.keys()) if (!seenCliPaths.has(k)) this.stateCache.delete(k);
    for (const k of this.metaCache.keys()) if (!scannedPaths.has(k)) this.metaCache.delete(k);
    return out;
  }
}
