import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { ConsolidatedEvaluationForm } from './ConsolidatedEvaluationForm';
import { isConsolidated, publicEvalApi, type AnyEvalContext, type EvalResponseItem } from './api';

/**
 * PUBLIC, no-login parent evaluation page. Reached via a tokenised link. Not
 * wrapped in the app shell or auth — the token in the URL is the only credential.
 */
export function PublicEvaluationPage(): JSX.Element {
  const { token = '' } = useParams();
  const [ctx, setCtx] = useState<AnyEvalContext | null>(null);
  const [answers, setAnswers] = useState<Record<string, EvalResponseItem>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    publicEvalApi
      .validate(token)
      .then((c) => {
        setCtx(c);
        if (c.status === 'completed') setDone(true);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'This link could not be opened.'));
  }, [token]);

  function setRating(qid: string, value: number): void {
    setAnswers((a) => ({ ...a, [qid]: { questionId: qid, ratingValue: value } }));
  }
  function setText(qid: string, value: string): void {
    setAnswers((a) => ({ ...a, [qid]: { questionId: qid, textValue: value } }));
  }

  async function submit(): Promise<void> {
    if (!ctx || isConsolidated(ctx)) return;
    const required = ctx.questions.filter((q) => q.type === 'rating');
    const missing = required.filter((q) => answers[q.id]?.ratingValue === undefined);
    if (missing.length > 0) {
      setSubmitError('Please rate every question before submitting.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await publicEvalApi.submit(token, Object.values(answers));
      setDone(true);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        {loadError ? (
          <Panel>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-6 shrink-0 text-amber-500" />
              <div>
                <h1 className="text-lg font-bold text-slate-800">This evaluation can’t be opened</h1>
                <p className="mt-1 text-sm text-slate-600">{loadError}</p>
              </div>
            </div>
          </Panel>
        ) : !ctx ? (
          <Panel>
            <p className="text-sm text-slate-500">Loading your evaluation…</p>
          </Panel>
        ) : isConsolidated(ctx) ? (
          // One form covering every teacher of one student. A separate component
          // because its layout is mobile-first and shares nothing but the shell.
          <ConsolidatedEvaluationForm token={token} ctx={ctx} />
        ) : done ? (
          <Panel>
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 className="size-12 text-emerald-500" />
              <h1 className="text-xl font-bold text-slate-800">Thank you!</h1>
              <p className="text-sm text-slate-600">
                Your feedback for {ctx.teacher} has been recorded. You may close this page.
              </p>
            </div>
          </Panel>
        ) : (
          <div className="grid gap-4">
            <Panel>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{ctx.organizationName}</p>
              <h1 className="mt-1 text-xl font-bold text-slate-800">Teacher evaluation</h1>
              <p className="mt-1 text-sm text-slate-600">
                Please share your feedback on <strong>{ctx.teacher}</strong>
                {ctx.subject ? (
                  <>
                    {' '}for <strong>{ctx.subject}</strong>
                  </>
                ) : null}
                {ctx.student ? (
                  <>
                    {' '}taught to <strong>{ctx.student}</strong>
                  </>
                ) : null}
                .
              </p>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
                {ctx.class ? <div><dt className="inline font-medium">Class:</dt> <dd className="inline">{ctx.class}{ctx.section ? ` – ${ctx.section}` : ''}</dd></div> : null}
                {ctx.session ? <div><dt className="inline font-medium">Session:</dt> <dd className="inline">{ctx.session}</dd></div> : null}
              </dl>
            </Panel>

            {ctx.questions.map((q, i) => (
              <Panel key={q.id}>
                <p className="text-sm font-medium text-slate-800">
                  {i + 1}. {q.text}
                </p>
                {q.type === 'rating' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {ctx.scale.map((s) => {
                      const active = answers[q.id]?.ratingValue === s.value;
                      return (
                        <button
                          key={s.value}
                          type="button"
                          onClick={() => setRating(q.id, s.value)}
                          className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                            active ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'
                          }`}
                        >
                          {s.value} · {s.label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    value={answers[q.id]?.textValue ?? ''}
                    onChange={(e) => setText(q.id, e.target.value)}
                    rows={3}
                    className="mt-3 w-full rounded-md border border-slate-200 p-2 text-sm focus:border-blue-400 focus:outline-none"
                    placeholder="Type your comment (optional)…"
                  />
                )}
              </Panel>
            ))}

            {submitError ? <p className="text-sm text-red-600">{submitError}</p> : null}
            <button
              onClick={submit}
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {submitting ? 'Submitting…' : 'Submit evaluation'}
            </button>
            <p className="text-center text-xs text-slate-400">Your responses are confidential.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">{children}</div>;
}
