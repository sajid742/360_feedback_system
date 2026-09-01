import type { Branding } from '@/app/BrandingContext';
import { useBranding } from '@/app/BrandingContext';

/**
 * The chrome around every signed-out screen: sign-in, forgot/reset password, and the
 * first-run setup wizard.
 *
 * WHY IT EXISTS. This markup used to be copy-pasted four times — LoginPage,
 * PasswordPages, SetupPage and (for the tile) AppShell — each with the client's colours
 * inlined as hex. Branding had four places to land and they drifted.
 *
 * WHY IT TAKES `branding` AS A PROP rather than reading the context itself: it makes
 * this component purely presentational, with no hooks and no data fetching, which is
 * what lets the Brand Studio render the SAME component against an unsaved draft. The
 * administrator's preview cannot drift from the real sign-in page, because it is the
 * real sign-in page. `AuthShellLive` below is the one-line wrapper for normal use.
 */
export function AuthShell({
  branding,
  title,
  subtitle,
  children,
  width = 'max-w-sm',
  heightClass = 'min-h-screen',
}: {
  branding: Branding;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: string;
  /** Full viewport for the real page; the studio preview passes a fixed height. */
  heightClass?: string;
}): JSX.Element {
  return (
    <div
      className={`flex ${heightClass} items-center justify-center p-4`}
      // Falls back to the original literal so the page still looks right in the moment
      // before branding lands, and if the branding request fails entirely.
      style={{ background: 'var(--auth-gradient, linear-gradient(135deg, #1c1840, #241f53))' }}
    >
      <div className={`w-full ${width} rounded-lg bg-card p-8 shadow-card-hover`}>
        <div className="mb-6 text-center">
          <BrandMark branding={branding} />
          <h1 className="text-xl font-extrabold tracking-tight">{title ?? branding.welcomeTitle}</h1>
          {subtitle !== '' ? (
            <p className="text-sm text-muted-foreground">{subtitle ?? branding.welcomeSubtitle}</p>
          ) : null}
        </div>
        {children}
        {branding.signInFooter || branding.supportEmail ? (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            {branding.signInFooter || `Need help? ${branding.supportEmail}`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The logo. An uploaded image when there is one, otherwise the client's initials on a
 * brand-coloured tile — so a client with no artwork still gets something that looks
 * deliberate rather than a placeholder.
 */
export function BrandMark({
  branding,
  size = 48,
  className = '',
}: {
  branding: Branding;
  size?: number;
  className?: string;
}): JSX.Element {
  if (branding.logoUrl) {
    return (
      <img
        src={branding.logoUrl}
        alt={branding.organizationName || branding.appName}
        className={`mx-auto mb-3 object-contain ${className}`}
        style={{ height: size, maxWidth: size * 3.5 }}
      />
    );
  }
  const initials = branding.shortName || '360';
  return (
    <div
      className={`mx-auto mb-3 flex items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand-dark font-extrabold text-white ${className}`}
      style={{ width: size, height: size, fontSize: initials.length > 3 ? size * 0.26 : size * 0.34 }}
    >
      {initials}
    </div>
  );
}

/** The ordinary case: same shell, branding taken from context. */
export function AuthShellLive(props: Omit<Parameters<typeof AuthShell>[0], 'branding'>): JSX.Element {
  return <AuthShell {...props} branding={useBranding()} />;
}
