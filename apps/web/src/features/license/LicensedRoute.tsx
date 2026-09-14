import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useEntitlements } from './useEntitlements';

/**
 * Wraps a route belonging to a licensed module.
 *
 * The menu already hides an unlicensed module, but a bookmark or a typed URL still
 * reaches the page — and the page then fires requests that all answer 404, which looks
 * like a broken screen rather than a module the customer has not bought. This says so
 * plainly instead.
 *
 * It is a courtesy, not the control: `LicensedFeatureGuard` refuses the same module
 * server-side regardless of what the browser does.
 */
export function LicensedRoute({ module, children }: { module: string; children: React.ReactNode }): JSX.Element {
  const { entitlements, loading } = useEntitlements();

  // Until the plan is known, render normally — the server is the real gate, and a
  // flash of "not included" on every page load would be worse than a brief delay.
  if (loading || !entitlements) return <>{children}</>;
  if (entitlements.modules.includes(module)) return <>{children}</>;

  const entry = entitlements.catalogue.find((c) => c.module === module);

  return (
    <Card className="mx-auto mt-10 grid max-w-lg gap-3 p-8 text-center">
      <ShieldAlert className="mx-auto size-8 text-muted-foreground" />
      <h1 className="text-lg font-extrabold tracking-tight">
        {entry?.label ?? 'This module'} is not included in your plan
      </h1>
      <p className="text-sm text-muted-foreground">
        It is unavailable to everyone in this organisation, whatever their role. Your data is unaffected.
      </p>
      {/* Name the plan that includes it rather than saying "contact your supplier" and
          leaving the customer to guess. The answer comes from the server's own
          catalogue, so it cannot drift away from what the guards enforce. */}
      <p className="text-sm text-muted-foreground">
        {entry?.upgradeToLabel ? (
          <>
            Available from <b className="text-foreground">{entry.upgradeToLabel}</b>.{' '}
          </>
        ) : null}
        <Link to="/upgrade" className="font-semibold text-brand hover:underline">
          Compare plans
        </Link>
      </p>
    </Card>
  );
}
