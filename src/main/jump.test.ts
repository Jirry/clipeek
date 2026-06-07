import { describe, it, expect } from 'vitest';
import { pickNextJump } from './jump';
import type { Session, SessionState } from '../shared/types';

// ⌃⌥J 的目标选择 —— 把循环规则钉死(红▸黄闪▸黄▸绿闪;都没有则在纯绿里循环;exited 从不跳)。
const S = (id: string, state: SessionState, lastActivity = 0): Session => ({
  id,
  state,
  lastActivity,
  tool: 'claude',
  cwd: '/x',
  name: id,
  title: id,
  detail: null,
});

describe('pickNextJump', () => {
  it('首按 → 活跃组里最紧急的(红 error)', () => {
    const ss = [S('g', 'done', 9), S('w', 'working', 1), S('e', 'error', 1), S('n', 'needsInput', 1), S('a', 'attention', 1)];
    expect(pickNextJump(ss, null)?.id).toBe('e');
  });

  it('按 红▸黄闪▸黄▸绿闪 循环走遍活跃组,到尾回绕,全程不碰纯绿', () => {
    const ss = [S('e', 'error', 1), S('n', 'needsInput', 1), S('w', 'working', 1), S('a', 'attention', 1), S('g', 'done', 1)];
    expect(pickNextJump(ss, null)?.id).toBe('e');
    expect(pickNextJump(ss, 'e')?.id).toBe('n');
    expect(pickNextJump(ss, 'n')?.id).toBe('w');
    expect(pickNextJump(ss, 'w')?.id).toBe('a');
    expect(pickNextJump(ss, 'a')?.id).toBe('e'); // 回绕,且没去 g(纯绿)
  });

  it('活跃组为空 → 退到「所有绿灯(done)」里循环(按最近活动倒序)', () => {
    const ss = [S('g1', 'done', 2), S('g2', 'done', 1), S('x', 'exited', 9)];
    expect(pickNextJump(ss, null)?.id).toBe('g1');
    expect(pickNextJump(ss, 'g1')?.id).toBe('g2');
    expect(pickNextJump(ss, 'g2')?.id).toBe('g1'); // 回绕
  });

  it('有任意活跃会话时,就只在活跃组里循环,纯绿被忽略', () => {
    const ss = [S('g', 'done', 9), S('w', 'working', 1)];
    expect(pickNextJump(ss, null)?.id).toBe('w');
    expect(pickNextJump(ss, 'w')?.id).toBe('w'); // 只有一个活跃 → 一直它
  });

  it('lastJumpId 已不在候选(已关/已变状态)→ 回到最紧急', () => {
    const ss = [S('e', 'error', 1), S('n', 'needsInput', 1)];
    expect(pickNextJump(ss, 'gone')?.id).toBe('e');
  });

  it('只剩 exited / 没有会话 → null(静默)', () => {
    expect(pickNextJump([S('x', 'exited', 1)], null)).toBeNull();
    expect(pickNextJump([], null)).toBeNull();
  });

  it('同优先级内按 lastActivity 倒序(最近活动的排前)', () => {
    const ss = [S('old', 'working', 1), S('new', 'working', 5)];
    expect(pickNextJump(ss, null)?.id).toBe('new');
  });
});
