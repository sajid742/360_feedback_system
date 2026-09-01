import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';
import { useBranding } from '@/app/BrandingContext';
import { AuthShell } from './AuthShell';
import { useAuth } from './AuthContext';

/**
 * Kept only as a fallback. The organisation now comes from the server at runtime
 * (`DEFAULT_ORG_SLUG`), so deploying for a new client no longer needs a web rebuild —
 * this build-time value is what that used to require.
 */
const BUILD_TIME_SLUG = import.meta.env.VITE_DEFAULT_ORG_SLUG ?? '';

export function LoginPage(): JSX.Element {
  const { login, completeMfa } = useAuth();
  const branding = useBranding();
  const navigate = useNavigate();
  const [organizationSlug, setOrganizationSlug] = useState(BUILD_TIME_SLUG);
  // Adopt the server's default once branding lands, unless the visitor has typed.
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (!slugTouched && branding.defaultOrgSlug) setOrganizationSlug(branding.defaultOrgSlug);
  }, [branding.defaultOrgSlug, slugTouched]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set by the API client when a session could not be refreshed, so the user is
  // told why they are back here instead of being dumped at a blank login (F-H1).
  const [params] = useSearchParams();
  const sessionExpired = params.get('expired') === '1';
  // A fresh installation has no organisation yet — offer the setup wizard (F22).
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    apiClient
      .get<{ needsSetup: boolean }>('/provisioning/status')
      .then((s) => setNeedsSetup(s.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  async function submitCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { mfaToken: challenge, user } = await login({ organizationSlug, email, password });
      if (challenge) setMfaToken(challenge);
      else navigate(user?.mustChangePassword ? '/set-password' : user?.mustEnrollMfa ? '/enroll-mfa' : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed. Check your credentials.');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitMfa(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!mfaToken) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await completeMfa(mfaToken, code);
      navigate(user?.mustChangePassword ? '/set-password' : user?.mustEnrollMfa ? '/enroll-mfa' : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid authentication code.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      branding={branding}
      subtitle={mfaToken ? 'Enter your authentication code' : undefined}
    >
      <>
        {mfaToken ? (
          <form onSubmit={submitMfa} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="code">Authentication code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6-digit code or backup code"
                autoFocus
              />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitCredentials} className="grid gap-4">
            {sessionExpired && !error ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Your session expired. Please sign in again to continue.
              </p>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="slug">Organization</Label>
              <Input id="slug" value={organizationSlug} onChange={(e) => { setSlugTouched(true); setOrganizationSlug(e.target.value); }} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={submitting} className="mt-1">
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
            <button
              type="button"
              onClick={() => navigate('/forgot-password')}
              className="text-center text-sm text-brand hover:underline"
            >
              Forgot password?
            </button>
            {/* A brand-new installation has no organisation to sign in to; point the
                first administrator at the setup wizard instead of a dead end (F22). */}
            {needsSetup ? (
              <button type="button" onClick={() => navigate('/setup')} className="text-center text-sm text-brand hover:underline">
                No organisation yet? Set one up
              </button>
            ) : null}
          </form>
        )}
      </>
    </AuthShell>
  );
}
