import { useMemo, useState } from 'react';
import { CheckCircle2, GraduationCap } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { publicEvalApi, type ConsolidatedContext } from './api';

/**
 * The consolidated parent form: one student, every teacher, one rating each, one submit.
 *
 * Built mobile-first, because this arrives as a WhatsApp link and is almost always
 * opened on a phone:
 *
 *  - One card per teacher, stacked. No table — a table of five rating columns is
 *    unreadable below about 500px and forces horizontal scrolling.
 *  - The rating buttons are a 5-column grid that fills the width, so every option is a
 *    full-height touch target rather than a wrapped row of small pills.
 *  - A sticky footer holds the count and the submit button, so the parent can submit
 *    from anywhere in the list without scrolling to the bottom.
 *  - A sticky progress bar appears once there are more than four teachers; below that
 *    the whole form is visible in a screen or two and the bar is just noise.
 *
 * Partial submission is allowed by default: a teacher the parent leaves unrated is
 * recorded as "not asked", never as a low score, and is excluded from that teacher's
 * average and from their anonymity count.
 */
export function ConsolidatedEvaluationForm({ token, ctx }: { token: string; ctx: ConsolidatedContext }): JSX.Element {
  const [ratings, setRatings] = useState<Record<string, number>>(
    () => Object.fromEntries(ctx.teachers.filter((t) => t.rating !== null).map((t) => [t.teacherId, t.rating as number])),
  );
  const [done, setDone] = useState(ctx.status === 'completed');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const rated = useMemo(() => Object.keys(ratings).length, [ratings]);
  const total = ctx.teachers.length;
  const showProgress = total > 4;

  async function submit(): Promise<void> {
    if (ctx.requireAll && rated < total) {
      setError(`Please rate all ${total} teachers before submitting.`);
      return;
    }
    if (rated === 0) {
      setError('Please rate at least one teacher before submitting.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await publicEvalApi.submitConsolidated(
        token,
        Object.entries(ratings).map(([teacherId, ratingValue]) => ({ teacherId, ratingValue })),
      );
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <CheckCircle2 className="size-12 text-emerald-500" />
          <h1 className="text-xl font-bold text-slate-800">Thank you!</h1>
          <p className="text-sm text-slate-600">
            Your feedback about {ctx.student ?? 'your child'}&rsquo;s teachers has been recorded. You may close this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3 pb-28">
      {/* ---- Who and what ---- */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{ctx.organizationName}</p>
        <h1 className="mt-1 text-lg font-bold text-slate-800 sm:text-xl">
          {ctx.student ? `${ctx.student}’s teachers` : 'Your child’s teachers'}
        </h1>
        {ctx.class || ctx.section ? (
          <p className="mt-0.5 text-sm text-slate-500">
            {[ctx.class, ctx.section].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {ctx.question ? (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{ctx.question.text}</p>
        ) : null}
        <p className="mt-2 text-xs text-slate-500">
          {ctx.requireAll
            ? `Please rate all ${total} teachers.`
            : 'Rate the teachers you feel able to comment on — you can leave any of them blank.'}
        </p>
      </div>

      {/* ---- Progress, only when the list is long enough to lose your place in ---- */}
      {showProgress ? (
        <div className="sticky top-0 z-10 -mx-1 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
          <div className="flex items-center justify-between text-xs font-medium text-slate-600">
            <span>Rated {rated} of {total}</span>
            <span>{Math.round((rated / total) * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-blue-600 transition-[width] duration-200"
              style={{ width: `${(rated / total) * 100}%` }}
            />
          </div>
        </div>
      ) : null}

      {/* ---- One card per teacher ---- */}
      {ctx.teachers.map((t) => {
        const value = ratings[t.teacherId];
        return (
          <div
            key={t.teacherId}
            className={`rounded-xl border bg-white p-4 shadow-sm transition-colors ${
              value === undefined ? 'border-slate-200' : 'border-blue-200'
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                <GraduationCap className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800">{t.teacher}</p>
                {t.subjects ? <p className="mt-0.5 truncate text-xs text-slate-500">{t.subjects}</p> : null}
              </div>
              {value !== undefined ? <CheckCircle2 className="mt-1 size-4 shrink-0 text-emerald-500" /> : null}
            </div>

            {/* Full-width grid rather than wrapped pills: on a phone every option stays
                a comfortable target and the row never reflows unpredictably. */}
            <div
              role="radiogroup"
              aria-label={`Rating for ${t.teacher ?? 'teacher'}`}
              className="mt-3 grid gap-1.5"
              style={{ gridTemplateColumns: `repeat(${Math.min(ctx.scale.length, 5)}, minmax(0, 1fr))` }}
            >
              {ctx.scale.map((s) => {
                const active = value === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setRatings((r) => ({ ...r, [t.teacherId]: s.value }))}
                    className={`flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-2 text-center transition-colors ${
                      active
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 bg-white text-slate-600 active:bg-slate-100'
                    }`}
                  >
                    <span className="text-sm font-bold leading-none">{s.value}</span>
                    <span className="text-[10px] leading-tight">{s.label}</span>
                  </button>
                );
              })}
            </div>

            {value !== undefined && !ctx.requireAll ? (
              <button
                type="button"
                onClick={() => setRatings((r) => { const { [t.teacherId]: _drop, ...rest } = r; return rest; })}
                className="mt-2 text-xs font-medium text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
              >
                Clear this rating
              </button>
            ) : null}
          </div>
        );
      })}

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {/* ---- Sticky submit: reachable from anywhere in a long list ---- */}
      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <span className="shrink-0 text-xs font-medium text-slate-500">
            {rated} of {total} rated
          </span>
          <button
            onClick={submit}
            disabled={submitting}
            className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white active:bg-blue-800 disabled:opacity-60"
          >
            {submitting ? 'Submitting…' : 'Submit ratings'}
          </button>
        </div>
        <p className="mx-auto mt-1.5 max-w-2xl text-center text-[11px] text-slate-400">
          Your responses are confidential and are never shown to teachers individually.
        </p>
      </div>
    </div>
  );
}
