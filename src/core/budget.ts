// How many NUworks applications you can still send, and how many matches to
// queue today so you land near your weekly limit without blowing the cap.

export interface NuworksBudgetInput {
  cap: number; // 100
  reserve: number; // slots kept for postings you find yourself
  usedNuworks: number | null; // count NUworks shows (source of truth when known)
  usedLocal: number; // submitted + applied_manual we know about
  weeklyLimit: number; // 20
  submittedThisWeek: number;
  approvedPending: number; // approved, not yet submitted
  queuedPending: number; // already waiting in your queue
  weekdaysLeft: number; // including today
  approveRate: number; // share of queued matches you approve (learned; starts 0.6)
  minDailyQueue: number;
  maxDailyQueue: number;
}

export interface NuworksBudget {
  used: number;
  cycleRemaining: number; // after the reserve
  weekRemaining: number;
  canApprove: boolean;
  dailyQueueTarget: number; // new matches to add to the queue today
}

export function nuworksBudget(i: NuworksBudgetInput): NuworksBudget {
  const used = Math.max(i.usedNuworks ?? 0, i.usedLocal);
  const cycleRemaining = Math.max(0, i.cap - i.reserve - used - i.approvedPending);
  const weekRemaining = Math.max(0, i.weeklyLimit - i.submittedThisWeek - i.approvedPending);
  const room = Math.min(cycleRemaining, weekRemaining);
  if (room === 0 || i.weekdaysLeft === 0) return { used, cycleRemaining, weekRemaining, canApprove: room > 0, dailyQueueTarget: 0 };
  const rate = Math.min(1, Math.max(0.2, i.approveRate));
  const wantToday = Math.ceil(room / i.weekdaysLeft / rate);
  const target = clamp(wantToday, i.minDailyQueue, i.maxDailyQueue) - i.queuedPending;
  // Never queue more than could actually be approved.
  const ceiling = Math.ceil(room / rate) - i.queuedPending;
  return { used, cycleRemaining, weekRemaining, canApprove: true, dailyQueueTarget: Math.max(0, Math.min(target, ceiling)) };
}

export function externalRemainingToday(maxPerDay: number, submittedToday: number): number {
  return Math.max(0, maxPerDay - submittedToday);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
