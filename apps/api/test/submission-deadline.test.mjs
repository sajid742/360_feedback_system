/**
 * Unit test for the shared submission-deadline guard.
 *
 * This is the one test in `test/` that does NOT need a running API or a database —
 * it imports the compiled helper directly, so run `npm run -w apps/api build` first
 * (the other suites in this folder have their own preconditions; see helpers.mjs).
 *
 * What it pins down is the bug this helper was written to fix: `submission_deadline`
 * is a PostgreSQL `date`, so Prisma returns midnight UTC of that day. Comparing that
 * instant directly against "now" — which every guard used to do — rejected
 * submissions from the START of the deadline day, and in a positive-offset timezone
 * from 05:00 that morning.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { submissionDeadlinePassed } from '../dist/common/dates/submission-deadline.js';

/** How Prisma hands back a `@db.Date` column: midnight UTC of the stored day. */
const asStoredDate = (yyyyMmDd) => new Date(`${yyyyMmDd}T00:00:00.000Z`);

/** An instant expressed in a fixed offset, so these cases do not depend on the host TZ. */
const at = (iso) => new Date(iso);

test('no deadline set never blocks', () => {
  assert.equal(submissionDeadlinePassed(null), false);
  assert.equal(submissionDeadlinePassed(undefined), false);
});

test('an unparseable deadline fails OPEN rather than closing the cycle', () => {
  assert.equal(submissionDeadlinePassed('not-a-date'), false);
  assert.equal(submissionDeadlinePassed(new Date('nonsense')), false);
});

test('a deadline comfortably in the future has not passed', () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  assert.equal(submissionDeadlinePassed(future), false);
});

test('a deadline comfortably in the past has passed', () => {
  assert.equal(submissionDeadlinePassed(asStoredDate('2020-01-01')), true);
});

// ---------------------------------------------------------------------------
// The regression itself. TZ is fixed per case via an explicit `now`, expressed as
// the UTC instant that corresponds to a local wall-clock time in Asia/Karachi
// (UTC+5) — the timezone the reference deployment runs in.
//
// Deadline: 9 September 2026. The parent should be able to submit all day on the
// 9th, local time. Before the fix, submission died at 2026-09-09T00:00:00Z, which
// is 05:00 on the 9th in Karachi.
// ---------------------------------------------------------------------------

test('the deadline DAY is included, not excluded (the reported bug)', () => {
  const deadline = asStoredDate('2026-09-09');
  const originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Karachi';
  try {
    // 07:54 local on the deadline morning — the exact shape of the reported failure.
    assert.equal(
      submissionDeadlinePassed(deadline, at('2026-09-09T02:54:00.000Z')),
      false,
      'a submission on the morning of the deadline day must be accepted',
    );
    // 23:30 local on the deadline day — still inside it.
    assert.equal(
      submissionDeadlinePassed(deadline, at('2026-09-09T18:30:00.000Z')),
      false,
      'a submission late on the deadline day must still be accepted',
    );
    // 00:30 local the following day — now genuinely late.
    assert.equal(
      submissionDeadlinePassed(deadline, at('2026-09-09T19:30:00.000Z')),
      true,
      'a submission after the deadline day has ended must be refused',
    );
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('a UTC deployment behaves sensibly at the day boundary', () => {
  const deadline = asStoredDate('2026-09-09');
  const originalTz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    assert.equal(submissionDeadlinePassed(deadline, at('2026-09-09T00:00:00.000Z')), false);
    assert.equal(submissionDeadlinePassed(deadline, at('2026-09-09T23:59:59.000Z')), false);
    assert.equal(submissionDeadlinePassed(deadline, at('2026-09-10T00:00:00.100Z')), true);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});
