import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useLicense } from './useLicense';

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
  const { license, loading } = useLicense();

  // Until the status is known, render normally — the server is the real gate, and a
  // flash of "not licensed" on every page load would be worse than a brief delay.
  if (loading || !license) return <>{children}</>;
  if (license.modules.some((m) => m.key === module)) return <>{children}</>;

  return (
    <Card className="mx-auto mt-10 grid max-w-lg gap-3 p-8 text-center">
      <ShieldAlert className="mx-auto size-8 text-muted-foreground" />
      <h1 className="text-lg font-extrabold tracking-tight">Not included in your licence</h1>
      <p className="text-sm text-muted-foreground">
        This module is not part of the licence installed for this organisation, so it is unavailable
        to everyone here. Your data is unaffected.
      </p>
      <p className="text-sm text-muted-foreground">
        <Link to="/license" className="font-semibold text-brand hover:underline">
          View licence details
        </Link>{' '}
        or contact your supplier to add it.
      </p>
    </Card>
  );
}
