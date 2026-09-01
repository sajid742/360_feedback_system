import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { LicenseView } from './api';

/**
 * A single line above the page, shown only when the licence needs attention.
 *
 * DELIBERATELY QUIET. An ACTIVE licence shows nothing at all, and the development
 * licence shows nothing either — a developer does not need reminding on every screen.
 * A banner that is always there stops being read, so this one appears only when
 * something is actually about to break.
 */
export function LicenseBanner({ license }: { license: LicenseView | null }): JSX.Element | null {
  if (!license) return null;
  if (license.isDevelopment) return null;
  if (license.status === 'ACTIVE') return null;

  const severe = license.status === 'EXPIRED' || license.status === 'SUSPENDED' || license.status === 'INVALID' || license.status === 'NONE';
  const cls = severe
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-amber-200 bg-amber-50 text-amber-900';

  return (
    <div className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm sm:px-6 print:hidden ${cls}`} role="status">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{license.message}</span>
      <Link to="/license" className="shrink-0 font-semibold underline underline-offset-2">
        Licence
      </Link>
    </div>
  );
}
