import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
/**
 * The minimum this banner needs. Typed structurally rather than against `LicenseView`
 * so it can be driven by the entitlement state, which every signed-in user can read —
 * the licence endpoint needs `configuration.read`, so before this the people most
 * likely to hit an expired subscription were the least likely to be told.
 */
export interface BannerState {
  status: string;
  message: string;
  isDevelopment: boolean;
  source?: string;
}

/**
 * A single line above the page, shown only when the licence needs attention.
 *
 * DELIBERATELY QUIET. An ACTIVE licence shows nothing at all, and the development
 * licence shows nothing either — a developer does not need reminding on every screen.
 * A banner that is always there stops being read, so this one appears only when
 * something is actually about to break.
 */
export function LicenseBanner({ license }: { license: BannerState | null }): JSX.Element | null {
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
      <Link
        to={license.source === 'subscription' ? '/upgrade' : '/license'}
        className="shrink-0 font-semibold underline underline-offset-2"
      >
        {license.source === 'subscription' ? 'Plans' : 'Licence'}
      </Link>
    </div>
  );
}
