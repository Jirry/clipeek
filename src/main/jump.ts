import { Session, SessionState, STATE_PRIORITY } from '../shared/types';

// ⌃⌥J 跳转的「下一个目标」选择 —— 纯逻辑(无 electron / I/O),便于单测。
// 优先「活跃」组:红(error)▸ 黄闪(needsInput)▸ 黄(working)▸ 绿闪(attention),按优先级 + 最近活动倒序;
// 活跃组为空 → 退到「所有绿灯(done)」;再空 → null(只剩 exited / 无会话)。
// lastJumpId 用于循环:取它在候选里的下一个(找不到 / 首次 → 第 0 个 = 最紧急),到尾回绕。
export const JUMP_ACTIVE_STATES = new Set<SessionState>(['error', 'needsInput', 'working', 'attention']);

function byUrgency(a: Session, b: Session): number {
  return STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] || b.lastActivity - a.lastActivity;
}

export function pickNextJump(sessions: Session[], lastJumpId: string | null): Session | null {
  let cands = sessions.filter((s) => JUMP_ACTIVE_STATES.has(s.state)).sort(byUrgency);
  if (!cands.length) cands = sessions.filter((s) => s.state === 'done').sort(byUrgency);
  if (!cands.length) return null;
  const i = lastJumpId ? cands.findIndex((s) => s.id === lastJumpId) : -1;
  return cands[(i + 1) % cands.length]; // i=-1 → 0;到尾回绕
}
