import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classify,
  deriveState,
  scanTitle,
  scanTail,
  parseRaw,
  readNotify,
  readDone,
  readBusy,
  encodeDirs,
  projectName,
  resolveLiveSessions,
} from './claude';
import type { JsonlRec, LiveProc } from './claude';

// 这些断言把多轮调试换来的状态/判活行为锁死(对应 clipeek-pitfalls 里那串「改了别回退」)。
// 任何改动若让某条挂掉,要么是真回退了,要么得连同样本一起更新——而不是默默改判定。

// —— 临时目录:落 JSONL 样本 / notify / done 文件 ——
let TMP = '';
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'clipeek-test-'));
});
afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

let seq = 0;
/** 写一个 JSONL 样本文件,返回路径。 */
function fixture(lines: string[]): string {
  const p = join(TMP, `fixture-${seq++}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}
/** 写一个标记文件(notify/done),设定其 mtime,返回实际 mtimeMs。 */
function marker(name: string, content: string, mtimeSec: number): number {
  const p = join(TMP, name);
  writeFileSync(p, content, 'utf8');
  utimesSync(p, mtimeSec, mtimeSec);
  return statSync(p).mtimeMs;
}

// 构造常见的一条 assistant/user 记录
const asst = (stop: string | null, lastBlock: { type: string; name?: string }) =>
  ({ type: 'assistant', message: { stop_reason: stop, content: [lastBlock] } }) as any;
const user = (lastBlock: { type: string; text?: string }) =>
  ({ type: 'user', message: { content: [lastBlock] } }) as any;

describe('classify', () => {
  it('assistant 末块 text + end_turn → 完成信号', () => {
    expect(classify(asst('end_turn', { type: 'text' }))).toEqual({ k: 'text', endTurn: true });
  });
  it('stop_sequence / max_tokens 也算一轮结束', () => {
    expect(classify(asst('stop_sequence', { type: 'text' }))).toEqual({ k: 'text', endTurn: true });
    expect(classify(asst('max_tokens', { type: 'text' }))).toEqual({ k: 'text', endTurn: true });
  });
  it('assistant text 但 stop_reason 非终态(还在流式)→ 未结束', () => {
    expect(classify(asst(null, { type: 'text' }))).toEqual({ k: 'text', endTurn: false });
    expect(classify(asst('tool_use', { type: 'text' }))).toEqual({ k: 'text', endTurn: false });
  });
  it('末块 thinking → thinking', () => {
    expect(classify(asst('tool_use', { type: 'thinking' }))).toEqual({ k: 'thinking' });
  });
  it('末块普通 tool_use → toolUse(带工具名)', () => {
    expect(classify(asst('tool_use', { type: 'tool_use', name: 'Edit' }))).toEqual({ k: 'toolUse', name: 'Edit' });
  });
  it('末块阻塞型 tool_use(AskUserQuestion/ExitPlanMode)也归 toolUse(由 deriveState 再判 needsInput)', () => {
    expect(classify(asst('tool_use', { type: 'tool_use', name: 'AskUserQuestion' }))).toEqual({
      k: 'toolUse',
      name: 'AskUserQuestion',
    });
  });
  it('user 末块 tool_result → toolResult', () => {
    expect(classify(user({ type: 'tool_result' }))).toEqual({ k: 'toolResult' });
  });
  it('真人 user 文本 → userText', () => {
    expect(classify(user({ type: 'text', text: '帮我改个 bug' }))).toEqual({ k: 'userText' });
  });
  it('伪 user 消息(命令注入/系统提醒)→ null(噪声,判状态时要跳过)', () => {
    expect(classify(user({ type: 'text', text: '<local-command-stdout>foo</local-command-stdout>' }))).toBeNull();
    expect(classify(user({ type: 'text', text: '<system-reminder>x</system-reminder>' }))).toBeNull();
    expect(classify({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'hi' }] } })).toBeNull();
  });
});

describe('deriveState', () => {
  it('kind=null → 回退 done(诊断钩子负责暴露,不靠显色糊弄)', () => {
    expect(deriveState(null)).toEqual({ state: 'done', detail: 'idle' });
  });
  it('text+end_turn → done;未 end_turn → working/replying', () => {
    expect(deriveState({ k: 'text', endTurn: true })).toEqual({ state: 'done', detail: 'idle' });
    expect(deriveState({ k: 'text', endTurn: false })).toEqual({ state: 'working', detail: 'replying' });
  });
  it('thinking / 普通 toolUse / toolResult / userText → working', () => {
    expect(deriveState({ k: 'thinking' }).state).toBe('working');
    expect(deriveState({ k: 'toolUse', name: 'Bash' })).toEqual({ state: 'working', detail: 'executing' });
    expect(deriveState({ k: 'toolResult' }).state).toBe('working');
    expect(deriveState({ k: 'userText' }).state).toBe('working');
  });
  it('阻塞工具 → needsInput(黄闪),ExitPlanMode=plan / AskUserQuestion=question', () => {
    expect(deriveState({ k: 'toolUse', name: 'ExitPlanMode' })).toEqual({ state: 'needsInput', detail: 'plan' });
    expect(deriveState({ k: 'toolUse', name: 'AskUserQuestion' })).toEqual({ state: 'needsInput', detail: 'question' });
  });
  it('error → error/crashed', () => {
    expect(deriveState({ k: 'error' })).toEqual({ state: 'error', detail: 'crashed' });
  });
});

describe('scanTail / parseRaw(真实文件尾部)', () => {
  it('尾部停在 tool_result → toolResult(deriveState 会判 working;靠 Stop hook 的 done 才翻完成)', () => {
    const p = fixture([
      JSON.stringify({ type: 'assistant', cwd: '/u/proj', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit' }] } }),
      JSON.stringify({ type: 'user', cwd: '/u/proj', message: { content: [{ type: 'tool_result' }] } }),
    ]);
    const r = parseRaw(p)!;
    expect(r.cwd).toBe('/u/proj');
    expect(r.kind).toEqual({ k: 'toolResult' });
  });
  it('尾随的伪 user 噪声不影响判定:往前找到 assistant 的 end_turn → done', () => {
    const { kind } = scanTail(
      fixture([
        JSON.stringify({ type: 'assistant', cwd: '/x', message: { stop_reason: 'end_turn', content: [{ type: 'text' }] } }),
        JSON.stringify({ type: 'user', cwd: '/x', message: { content: [{ type: 'text', text: '<local-command-stdout>z</local-command-stdout>' }] } }),
      ]),
      64 * 1024,
    );
    expect(kind).toEqual({ k: 'text', endTurn: true });
  });
  it('api_error 终态 → error;但自动重试中(retryAttempt<maxRetries)是瞬时态,不判红', () => {
    const terminal = scanTail(
      fixture([
        JSON.stringify({ type: 'assistant', cwd: '/x', message: { stop_reason: 'end_turn', content: [{ type: 'text' }] } }),
        JSON.stringify({ type: 'system', subtype: 'api_error' }),
      ]),
      64 * 1024,
    );
    expect(terminal.kind).toEqual({ k: 'error' });

    const retrying = scanTail(
      fixture([
        JSON.stringify({ type: 'assistant', cwd: '/x', message: { stop_reason: 'end_turn', content: [{ type: 'text' }] } }),
        JSON.stringify({ type: 'system', subtype: 'api_error', retryAttempt: 1, maxRetries: 3 }),
      ]),
      64 * 1024,
    );
    expect(retrying.kind).toEqual({ k: 'text', endTurn: true }); // 跳过瞬时错误,落到真实状态
  });
  it('parseRaw 找不到 cwd → null', () => {
    expect(parseRaw(fixture([JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text' }] } })]))).toBeNull();
  });
});

describe('scanTitle', () => {
  it('custom-title 优先于 ai-title', () => {
    expect(scanTitle([JSON.stringify({ type: 'ai-title', aiTitle: 'AI 名' }), JSON.stringify({ type: 'custom-title', customTitle: '我的名' })].join('\n'))).toBe('我的名');
  });
  it('只有 ai-title 时取 ai-title;都没有 → 空串', () => {
    expect(scanTitle(JSON.stringify({ type: 'ai-title', aiTitle: 'AI 名' }))).toBe('AI 名');
    expect(scanTitle('{"type":"assistant"}')).toBe('');
  });
});

describe('readNotify / readDone(mtime 相对 transcript)', () => {
  it('done 标记 mtime ≥ transcript → true(本轮已结束);更早 → false', () => {
    const m = marker('done-sid', 'done', 2_000_000);
    expect(readDone('done-sid', m - 1000, TMP)).toBe(true);
    expect(readDone('done-sid', m, TMP)).toBe(true); // >= 含相等
    expect(readDone('done-sid', m + 5000, TMP)).toBe(false); // 新一轮已往后写
    expect(readDone('no-such-sid', 0, TMP)).toBe(false);
  });
  it('notify:仅当晚于 transcript 才生效;permission_prompt→permission,idle_prompt→idle,未知→null', () => {
    const mp = marker('perm-sid', 'permission_prompt', 3_000_000);
    expect(readNotify('perm-sid', mp - 1000, TMP)).toBe('permission');
    expect(readNotify('perm-sid', mp, TMP)).toBeNull(); // <= transcript = 已回应
    const mi = marker('idle-sid', 'idle_prompt', 3_000_000);
    expect(readNotify('idle-sid', mi - 1000, TMP)).toBe('idle');
    const mu = marker('unk-sid', 'something_else', 3_000_000);
    expect(readNotify('unk-sid', mu - 1000, TMP)).toBeNull();
    expect(readNotify('missing', 0, TMP)).toBeNull();
  });
});

describe('readBusy(用户已提交、jsonl 写盘滞后)', () => {
  it('busy 标记晚于 transcript → 执行中;jsonl 追上(≥busy)→ 失效', () => {
    const m = marker('busy-sid', 'busy', 4_000_000);
    expect(readBusy('busy-sid', m - 1000, TMP)).toBe(true); // jsonl 还停在上一轮(更早)→ 处理中,别显完成态
    expect(readBusy('busy-sid', m, TMP)).toBe(false); // 同刻(jsonl 已写本轮 user)→ 交给 jsonl 判,不需 busy
    expect(readBusy('busy-sid', m + 5000, TMP)).toBe(false); // jsonl 已写入本轮内容、追上 → busy 失效
    expect(readBusy('no-such-sid', 0, TMP)).toBe(false);
  });
});

describe('encodeDirs / projectName', () => {
  it('encodeDirs:/→-;含 . 时再给一个 .→- 的候选', () => {
    expect(encodeDirs('/Users/x/proj')).toEqual(['-Users-x-proj']);
    expect(encodeDirs('/Users/x/.config/p')).toEqual(['-Users-x-.config-p', '-Users-x--config-p']);
  });
  it('projectName:取最后一个非隐藏段(cd 进 .obsidian 不会显示成 .obsidian)', () => {
    expect(projectName('/Users/x/proj')).toBe('proj');
    expect(projectName('/Users/x/.obsidian')).toBe('x');
  });
});

describe('resolveLiveSessions(判活精确对位)', () => {
  const J = (sid: string, dir: string, mtimeMs: number): JsonlRec => ({ sid, dir, mtimeMs, path: `/p/${dir}/${sid}.jsonl` });
  function index(recs: JsonlRec[]) {
    const bySid = new Map<string, JsonlRec>();
    const byDir = new Map<string, JsonlRec[]>();
    for (const r of recs) {
      bySid.set(r.sid, r);
      (byDir.get(r.dir) ?? byDir.set(r.dir, []).get(r.dir)!).push(r);
    }
    for (const a of byDir.values()) a.sort((x, y) => y.mtimeMs - x.mtimeMs);
    return { bySid, byDir };
  }

  it('僵尸:进程没了的会话(uuid 不在存活集)绝不出现', () => {
    const { bySid, byDir } = index([J('alive', '-a', 200), J('zombie', '-a', 300)]); // zombie 更新但进程已退
    const procs: LiveProc[] = [{ pid: 1, cwd: '/a', uuid: 'u-alive' }];
    const focus = new Map([['u-alive', ['alive']]]);
    const res = resolveLiveSessions(procs, bySid, byDir, focus);
    expect([...res.keys()]).toEqual(['alive']);
    expect(res.get('alive')).toBe(1);
  });

  it('同一 tab 先后多会话:取 transcript mtime 最新的(老 focus 残留不会贴错)', () => {
    const { bySid, byDir } = index([J('old', '-a', 100), J('new', '-a', 200)]);
    const procs: LiveProc[] = [{ pid: 7, cwd: '/a', uuid: 'U' }];
    const focus = new Map([['U', ['old', 'new']]]);
    const res = resolveLiveSessions(procs, bySid, byDir, focus);
    expect([...res.keys()]).toEqual(['new']);
  });

  it('无 uuid(非 Warp/老会话)→ 退回该 cwd 目录里最新的 jsonl', () => {
    const { bySid, byDir } = index([J('s1', '-a-b', 200), J('s2', '-a-b', 100)]);
    const procs: LiveProc[] = [{ pid: 9, cwd: '/a/b', uuid: null }];
    const res = resolveLiveSessions(procs, bySid, byDir, new Map());
    expect([...res.keys()]).toEqual(['s1']);
  });

  it('同目录两个存活进程 → 各认领最新的两个,不重复', () => {
    const { bySid, byDir } = index([J('s1', '-a-b', 300), J('s2', '-a-b', 200), J('s3', '-a-b', 100)]);
    const procs: LiveProc[] = [
      { pid: 1, cwd: '/a/b', uuid: null },
      { pid: 2, cwd: '/a/b', uuid: null },
    ];
    const res = resolveLiveSessions(procs, bySid, byDir, new Map());
    expect(new Set(res.keys())).toEqual(new Set(['s1', 's2']));
    expect(res.size).toBe(2);
  });

  it('精确认领优先于兜底:兜底进程不会抢走精确进程要的 sid', () => {
    const { bySid, byDir } = index([J('sx', '-a-b', 300), J('sy', '-a-b', 200)]);
    const procs: LiveProc[] = [
      { pid: 1, cwd: '/a/b', uuid: 'U' }, // 精确指向 sx
      { pid: 2, cwd: '/a/b', uuid: null }, // 兜底
    ];
    const focus = new Map([['U', ['sx']]]);
    const res = resolveLiveSessions(procs, bySid, byDir, focus);
    expect(res.get('sx')).toBe(1); // 精确
    expect(res.get('sy')).toBe(2); // 兜底拿次新的,没抢 sx
  });
});
