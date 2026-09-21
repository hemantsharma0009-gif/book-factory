/**
 * Cadence handling. The engine does not daemonise: `next-due` reports whether
 * a run is due, so cron, a systemd timer or Vercel Cron can drive it.
 */
export const CADENCES = {
  daily: { label: "Every day", days: 1 },
  weekly: { label: "Weekly", days: 7 },
  fortnightly: { label: "Fortnightly", days: 14 },
  monthly: { label: "Monthly", days: 30 },
};

export function nextRunAt(schedule, lastRunAt) {
  if (!schedule?.enabled) return null;
  const cadence = CADENCES[schedule.cadence] || CADENCES.weekly;
  // Parsed defensively: `hour || 9` would silently turn a midnight schedule
  // into a 9am one, because 0 is falsy.
  const [rawHour, rawMinute] = String(schedule.time || "09:00").split(":");
  const parsedHour = Number.parseInt(rawHour, 10);
  const parsedMinute = Number.parseInt(rawMinute, 10);
  const hour = Number.isInteger(parsedHour) && parsedHour >= 0 && parsedHour <= 23 ? parsedHour : 9;
  const minute = Number.isInteger(parsedMinute) && parsedMinute >= 0 && parsedMinute <= 59 ? parsedMinute : 0;

  const base = lastRunAt ? new Date(lastRunAt) : new Date();
  const next = new Date(base);
  next.setDate(next.getDate() + (lastRunAt ? cadence.days : 0));
  next.setHours(hour, minute, 0, 0);

  if (next.getTime() <= Date.now() && !lastRunAt) next.setDate(next.getDate() + cadence.days);
  return next.getTime();
}

export function isDue(schedule, lastRunAt) {
  const next = nextRunAt(schedule, lastRunAt);
  return next !== null && next <= Date.now();
}

/**
 * Guards for an UNATTENDED run. A cron job that spends money needs to be able
 * to stop itself, and the dangerous failure is not technical: if generation
 * outruns approval, you pay for books nobody reads.
 *
 * @returns {{ run: boolean, reason: string }}
 */
export function shouldRun(state, now = Date.now()) {
  const schedule = state.schedule;

  if (!schedule?.enabled) return { run: false, reason: "schedule is disabled" };

  if (!isDue(schedule, state.runs[0]?.at)) {
    const next = nextRunAt(schedule, state.runs[0]?.at);
    return { run: false, reason: `not due until ${new Date(next).toLocaleString()}` };
  }

  // The backlog guard. Books awaiting approval are books you have paid for and
  // not yet read; generating more of them is how an autonomous pipeline wastes
  // money quietly.
  const maxPending = Number(schedule.maxPending ?? 3);
  const pending = state.books.filter((b) => b.status === "awaiting_approval").length;
  if (pending >= maxPending) {
    return {
      run: false,
      reason: `${pending} book(s) already awaiting approval (limit ${maxPending}) — review them first`,
    };
  }

  // The budget guard, over a rolling 30 days.
  const budget = Number(schedule.monthlyBudgetUsd ?? 20);
  const since = now - 30 * 86400000;
  const spent = state.runs
    .filter((r) => r.at >= since)
    .reduce((total, r) => total + (r.cost?.usd || 0), 0);
  if (spent >= budget) {
    return {
      run: false,
      reason: `$${spent.toFixed(2)} spent in the last 30 days (budget $${budget.toFixed(2)})`,
    };
  }

  return {
    run: true,
    reason: `due; ${pending}/${maxPending} pending, $${spent.toFixed(2)}/$${budget.toFixed(2)} spent`,
  };
}
