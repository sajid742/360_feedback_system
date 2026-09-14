/**
 * One answer to "has this cycle's submission deadline passed?", shared by every
 * guard that asks — internal feedback (CycleService.assertOpen) and parent/external
 * feedback (EvaluationLinkService).
 *
 * WHY THIS EXISTS. `appraisal_cycles.submission_deadline` is a PostgreSQL `date`
 * (schema.prisma: `@db.Date`), so Prisma hands it back as midnight **UTC** of that
 * calendar day: a deadline of "2026-09-09" arrives as `2026-09-09T00:00:00.000Z`.
 * Every call site used to compare that instant directly against `Date.now()`, which
 * refuses submissions from the very START of the deadline day rather than the end —
 * and in a positive-offset timezone, from before anyone is awake. Measured against a
 * real database with TZ=Asia/Karachi, a deadline of 9 September began rejecting
 * submissions at 05:00 on the morning of 9 September.
 *
 * The documented intent (CycleService.assertOpen) is "on/before its deadline", so
 * the deadline DAY is included. We take the calendar parts as stored — they are the
 * UTC parts, because that is how a `date` round-trips — and rebuild the end of that
 * day in the SERVER's timezone. That is deliberately the same clock the reminder
 * scheduler already runs on (the container's `TZ`, documented in ops/DOCKER.md §26),
 * so "your deadline is 9 September" means the same thing to the person who set it,
 * the reminder that chases it, and the guard that enforces it.
 *
 * A deployment left at `TZ=UTC` behaves exactly as before at the day boundary; one
 * set to the client's timezone — which ops/DOCKER.md §26 tells you to do — now
 * accepts feedback for the whole of the deadline day, locally.
 */
export function submissionDeadlinePassed(
  deadline: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!deadline) return false;

  const stored = deadline instanceof Date ? deadline : new Date(deadline);
  // An unparseable deadline must not silently close a cycle. Failing open here means
  // at worst a late submission; failing closed would mean rejecting every parent with
  // a message nobody can act on.
  if (Number.isNaN(stored.getTime())) return false;

  const endOfDeadlineDay = new Date(
    stored.getUTCFullYear(),
    stored.getUTCMonth(),
    stored.getUTCDate(),
    23,
    59,
    59,
    999,
  );
  return now.getTime() > endOfDeadlineDay.getTime();
}
