import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, TrendingUp } from 'lucide-react';
import { entitlementsApi, type LimitUsage } from './useEntitlements';

/**
 * One line above the page when the organisation is close to, or past, a plan limit.
 *
 * WHY THIS EXISTS AT ALL. A limit that is only enforced at the moment of refusal turns
 * into a support call: somebody tries to add the 26th employee, is told no, and has no
 * idea why or what to do. Warning at 80% turns a wall into a decision.
 *
 * DELIBERATELY QUIET. Nothing is shown below 80%, and nothing is shown when every
 * limit is unlimited. A banner that is always present stops being read.
 */
export function LimitBanner(): JSX.Element | null {
  const [rows, setRows] = useState<LimitUsage[] | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    entitlementsApi
      .usage()
      // Never break the page over a banner. A user without a subscription, or a failed
      // request, simply sees nothing extra.
      .then((v) => !cancelled && setRows(v.limits))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!rows) return null;
  const notable = rows.filter((r) => (r.exceeded || r.warning) && !dismissed.includes(r.key));
  if (notable.length === 0) return null;

  // One banner, worst first: three stacked warnings would be worse than the problem.
  const worst = notable.find((r) => r.exceeded) ?? notable[0];
  const severe = worst.exceeded;

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm sm:px-6 print:hidden ${
        severe ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'
      }`}
    >
      {severe ? <AlertTriangle className="size-4 shrink-0" /> : <TrendingUp className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1">
        {severe ? (
          <>
            <b>{worst.label}:</b> you have reached your plan limit of {worst.limit}. New ones cannot be added until you
            upgrade or remove some — nothing already recorded is affected.
          </>
        ) : (
          <>
            <b>{worst.label}:</b> {worst.used} of {worst.limit} used ({worst.percent}%).
          </>
        )}
        {notable.length > 1 ? ` (+${notable.length - 1} other limit${notable.length === 2 ? '' : 's'} near capacity)` : ''}
      </span>
      <Link to="/upgrade" className="shrink-0 font-semibold underline underline-offset-2">
        View plans
      </Link>
      <button
        type="button"
        onClick={() => setDismissed((d) => [...d, worst.key])}
        className="shrink-0 rounded px-1.5 text-xs opacity-70 hover:opacity-100"
        title="Hide until the next page load"
      >
        Dismiss
      </button>
    </div>
  );
}
