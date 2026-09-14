import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Lock, Minus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { entitlementsApi, useEntitlements, type EntitlementLimits } from './useEntitlements';

interface PlanView {
  code: string;
  label: string;
  blurb: string;
  modules: string[];
  limits: EntitlementLimits;
}

/** Limits worth putting on a comparison table — the ones a buyer actually asks about. */
const HEADLINE_LIMITS: { key: keyof EntitlementLimits; label: string }[] = [
  { key: 'maxEmployees', label: 'Employees' },
  { key: 'maxUsers', label: 'User accounts' },
  { key: 'maxActiveCycles', label: 'Active feedback cycles' },
  { key: 'maxCampuses', label: 'Campuses' },
  { key: 'maxStudents', label: 'Students' },
  { key: 'maxParentLinksPerMonth', label: 'Parent invitations / month' },
  { key: 'maxEmailsPerMonth', label: 'Emails / month' },
  { key: 'maxImportRowsPerFile', label: 'Rows per import' },
  { key: 'dataRetentionMonths', label: 'Data retention (months)' },
];

const show = (v: number | null): string => (v === null ? 'Unlimited' : v === 0 ? '—' : v.toLocaleString());

/**
 * What each plan includes, and what this organisation is on.
 *
 * This is where a locked menu entry leads. It exists so a customer who cannot use a
 * feature still learns that it exists and what it would take to have it — the whole
 * commercial point of tiering. It compares; it does not transact. Choosing and paying
 * for a plan happens on /subscription, which this page links to.
 */
export function UpgradePage(): JSX.Element {
  const { entitlements } = useEntitlements();
  const [plans, setPlans] = useState<PlanView[] | null>(null);

  useEffect(() => {
    entitlementsApi
      .plans()
      .then((v) => setPlans(v.plans))
      .catch(() => setPlans([]));
  }, []);

  const current = entitlements?.plan ?? null;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Plans</h1>
        <p className="text-sm text-muted-foreground">
          {entitlements?.planLabel
            ? `Your organisation is on ${entitlements.planLabel}.`
            : 'What each plan includes.'}{' '}
          {entitlements?.source === 'license'
            ? 'This installation runs on an installed licence rather than a subscription.'
            : ''}
        </p>
      </div>

      {!plans ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            {plans.map((p) => (
              <Card
                key={p.code}
                className={`grid content-start gap-3 p-5 ${p.code === current ? 'border-brand ring-1 ring-brand/40' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-bold">{p.label}</h2>
                  {p.code === current ? <Badge variant="brand">Current plan</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">{p.blurb}</p>
                <ul className="mt-1 grid gap-1 text-sm">
                  {HEADLINE_LIMITS.slice(0, 4).map(({ key, label }) => (
                    <li key={key} className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-medium">{show(p.limits[key] as number | null)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>

          {/* What is in each plan, module by module. The catalogue comes from the
              server so this table can never disagree with what the guards enforce. */}
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Feature</th>
                  {plans.map((p) => (
                    <th key={p.code} className="p-3 text-center">{p.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(entitlements?.catalogue ?? []).map((entry) => (
                  <tr key={entry.module} className="border-t border-border">
                    <td className="p-3">
                      <span className="font-medium">{entry.label}</span>
                      {!entry.included ? <Lock className="ml-1.5 inline size-3 text-muted-foreground" /> : null}
                    </td>
                    {plans.map((p) => (
                      <td key={p.code} className="p-3 text-center">
                        {p.modules.includes(entry.module) ? (
                          <Check className="inline size-4 text-emerald-600" />
                        ) : (
                          <Minus className="inline size-4 text-muted-foreground/40" />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
                {HEADLINE_LIMITS.map(({ key, label }) => (
                  <tr key={key} className="border-t border-border bg-muted/20">
                    <td className="p-3 text-muted-foreground">{label}</td>
                    {plans.map((p) => (
                      <td key={p.code} className="p-3 text-center font-medium">
                        {show(p.limits[key] as number | null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="p-5 text-sm">
            <p className="font-medium">To change your plan</p>
            <p className="mt-1 text-muted-foreground">
              Choose a plan on the{' '}
              <Link to="/subscription" className="font-semibold text-brand hover:underline">
                Subscription
              </Link>{' '}
              page. A free plan applies immediately; a paid plan raises an invoice and takes effect once the payment is
              recorded. Nothing you have already recorded is affected either way.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
