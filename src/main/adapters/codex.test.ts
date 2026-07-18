import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, deriveState, parseTail } from './codex';

// 锁住 codex 会话状态判定(对应 memory clipeek-codex-research 的事件词表 + clipeek-parse-not-paper-over 铁律)。
// 任何改动若让某条挂掉,要么真回退了,要么得连同真实样本一起更新——不许默默改判定。

let TMP = '';
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'clipeek-codex-test-'));
});
afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
function writeRollout(lines: object[]): string {
  const p = join(TMP, `rollout-${seq++}.jsonl`);
  writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  return p;
}
const meta = (cwd = '/x'): object => ({ type: 'session_meta', payload: { session_id: 's', cwd, source: 'cli' } });
const ev = (t: string, extra: object = {}): object => ({ type: 'event_msg', payload: { type: t, ...extra } });
const resp = (t: string, extra: object = {}): object => ({ type: 'response_item', payload: { type: t, ...extra } });

describe('classify', () => {
  it('event_msg:turn 边界 + 子事件', () => {
    expect(classify(ev('task_complete'))).toBe('done');
    expect(classify(ev('turn_aborted'))).toBe('done');
    expect(classify(ev('error'))).toBe('error');
    expect(classify(ev('task_started'))).toBe('thinking');
    expect(classify(ev('agent_reasoning'))).toBe('thinking');
    expect(classify(ev('agent_message'))).toBe('replying');
    expect(classify(ev('exec_command_end'))).toBe('executing');
    expect(classify(ev('patch_apply_end'))).toBe('executing');
    expect(classify(ev('mcp_tool_call_end'))).toBe('executing');
    expect(classify(ev('web_search_end'))).toBe('executing');
    expect(classify(ev('user_message'))).toBe('user');
  });
  it('event_msg 噪声 → null', () => {
    expect(classify(ev('token_count'))).toBeNull();
    expect(classify(ev('thread_name_updated', { thread_name: 'x' }))).toBeNull();
    expect(classify(ev('context_compacted'))).toBeNull();
  });
  it('response_item', () => {
    expect(classify(resp('reasoning'))).toBe('thinking');
    expect(classify(resp('function_call'))).toBe('executing');
    expect(classify(resp('function_call_output'))).toBe('executing');
    expect(classify(resp('custom_tool_call'))).toBe('executing');
    expect(classify(resp('web_search_call'))).toBe('executing');
    expect(classify(resp('message', { role: 'assistant' }))).toBe('replying');
    expect(classify(resp('message', { role: 'user' }))).toBe('user');
    expect(classify(resp('message', { role: 'developer' }))).toBeNull(); // 会话开头注入,非状态信号
  });
  it('session_meta / turn_context / 非法 → null', () => {
    expect(classify({ type: 'session_meta', payload: {} })).toBeNull();
    expect(classify({ type: 'turn_context' })).toBeNull();
    expect(classify(null)).toBeNull();
    expect(classify({})).toBeNull();
  });
});

describe('deriveState', () => {
  it('kind → 状态/子状态', () => {
    expect(deriveState(null)).toEqual({ state: 'done', detail: 'idle' }); // 无信号 = 等你
    expect(deriveState('done')).toEqual({ state: 'done', detail: 'idle' });
    expect(deriveState('error')).toEqual({ state: 'error', detail: 'crashed' });
    expect(deriveState('thinking')).toEqual({ state: 'working', detail: 'thinking' });
    expect(deriveState('replying')).toEqual({ state: 'working', detail: 'replying' });
    expect(deriveState('executing')).toEqual({ state: 'working', detail: 'executing' });
    expect(deriveState('user')).toEqual({ state: 'working', detail: 'executing' });
  });
});

describe('parseTail', () => {
  it('末尾 task_complete → done,并从 thread_name_updated 取标题', () => {
    const p = writeRollout([
      meta(),
      ev('task_started'),
      resp('message', { role: 'user' }),
      ev('thread_name_updated', { thread_name: '清理缓存' }),
      resp('message', { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
      ev('token_count'), // 噪声,跳过
      ev('task_complete', { last_agent_message: 'ok' }),
    ]);
    const r = parseTail(p);
    expect(r.kind).toBe('done');
    expect(r.name).toBe('清理缓存');
  });
  it('turn 进行中(末尾 exec_command_end,无 task_complete)→ executing', () => {
    const p = writeRollout([meta(), ev('task_started'), resp('function_call'), ev('exec_command_end'), ev('token_count')]);
    expect(parseTail(p).kind).toBe('executing');
  });
  it('末尾 error → error', () => {
    const p = writeRollout([meta(), ev('task_started'), ev('error', { message: 'boom' })]);
    expect(parseTail(p).kind).toBe('error');
  });
  it('只有 meta(还没开 turn)→ null(deriveState 会当「等你」)', () => {
    const p = writeRollout([meta()]);
    expect(parseTail(p).kind).toBeNull();
  });
  it('末条记录超大(>64KB)→ 扩读后仍解析出状态,不误判 done', () => {
    // 若不扩读:64KB 尾部只剩这条巨大 function_call_output 的截断片、JSON.parse 全失败 → kind=null
    //   → deriveState 误判 done → poll 里新鲜 done 升成 attention 绿闪「该你了」(会话其实在跑)。这条锁死该扩读回退。
    const huge = 'x'.repeat(90 * 1024);
    const p = writeRollout([meta(), ev('task_started'), resp('function_call_output', { output: huge })]);
    const r = parseTail(p);
    expect(r.kind).toBe('executing');
    expect(r.parsedLines).toBeGreaterThan(0);
  });
});
