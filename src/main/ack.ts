// 「已确认」记录:用户点开某会话的终端 tab = 已知晓 → 抑制该会话的绿闪(attention)。
// 按「确认时刻」而非一次性开关来记:只要会话最后活动不晚于确认时刻就压住;
// 之后若有新一轮活动(mtime 前进越过确认时刻)→ 自动恢复绿闪(确实有没看过的新进展)。
// 纯内存:重启后清空(重启后本就该按新鲜度窗口重新提示),无需持久化。

const PRUNE_MS = 60 * 60 * 1000; // 1h 前的确认记录已无意义(早超出 attention 窗口),顺手清掉防无限增长

const ackedAt = new Map<string, number>(); // sessionId → 用户确认时刻(wall-clock ms)

/** 用户打开了该会话对应的终端 tab —— 记下确认时刻。 */
export function acknowledge(sessionId: string): void {
  const now = Date.now();
  ackedAt.set(sessionId, now);
  if (ackedAt.size > 64) {
    for (const [k, t] of ackedAt) if (now - t > PRUNE_MS) ackedAt.delete(k);
  }
}

/** 用户是否已确认过「该会话在 lastActivityMs 之前(含)的全部进展」。 */
export function isAcknowledged(sessionId: string, lastActivityMs: number): boolean {
  const t = ackedAt.get(sessionId);
  return t != null && lastActivityMs <= t;
}
