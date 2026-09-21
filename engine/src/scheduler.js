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
  const [hour, minute] = String(schedule.time || "09:00").split(":").map(Number);

  const base = lastRunAt ? new Date(lastRunAt) : new Date();
  const next = new Date(base);
  next.setDate(next.getDate() + (lastRunAt ? cadence.days : 0));
  next.setHours(hour || 9, minute || 0, 0, 0);

  if (next.getTime() <= Date.now() && !lastRunAt) next.setDate(next.getDate() + cadence.days);
  return next.getTime();
}

export function isDue(schedule, lastRunAt) {
  const next = nextRunAt(schedule, lastRunAt);
  return next !== null && next <= Date.now();
}
