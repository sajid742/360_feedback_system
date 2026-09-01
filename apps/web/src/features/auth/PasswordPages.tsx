import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import { AuthShellLive } from './AuthShell';
import { useBranding } from '@/app/BrandingContext';
import { authApi } from './api';
import { useAuth } from './AuthContext';

/** Fallback only — the organisation now arrives from the server at runtime. */
const BUILD_TIME_SLUG = import.meta.env.VITE_DEFAULT_ORG_SLUG ?? '';

/**
 * The shell that used to be duplicated here is now `AuthShell`, shared with the sign-in
 * page and re-rendered by the Brand Studio preview. This alias keeps the call sites in
 * this file unchanged while the branding comes from context.
 */
function AuthShell(props: { title: string; subtitle: string; children: React.ReactNode }): JSX.Element {
  return <AuthShellLive {...props} />;
}

/** Forgot password — request a reset link by email. Always shows the same confirmation. */
export function ForgotPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const branding = useBranding();
  const [organizationSlug, setOrganizationSlug] = useState(BUILD_TIME_SLUG);
  const [slugTouched, setSlugTouched] = useState(false);
  useEffect(() => {
    if (!slugTouched && branding.defaultOrgSlug) setOrganizationSlug(branding.defaultOrgSlug);
  }, [branding.defaultOrgSlug, slugTouched]);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      await authApi.forgotPassword(organizationSlug, email);
    } catch {
      /* ignore — response is intentionally uniform */
    } finally {
      setSubmitting(false);
      setDone(true);
    }
  }

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a reset link">
      {done ? (
        <div className="grid gap-4 text-center">
          <p className="text-sm text-muted-foreground">
            If an account matches those details, a password-reset link has been sent to your email. The link expires
            shortly, so please use it soon.
          </p>
          <Button type="button" onClick={() => navigate('/login')}>
            Back to sign in
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="slug">Organization</Label>
            <Input id="slug" value={organizationSlug} onChange={(e) => { setSlugTouched(true); setOrganizationSlug(e.target.value); }} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <Button type="submit" disabled={submitting} className="mt-1">
            {submitting ? 'Sending…' : 'Send reset link'}
          </Button>
          <button type="button" onClick={() => navigate('/login')} className="text-center text-sm text-brand hover:underline">
            Back to sign in
          </button>
        </form>
      )}
    </AuthShell>
  );
}

/** Reset password — set a new password using the token from the emailed link. */
export function ResetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'This reset link is invalid or has expired.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Reset your password" subtitle="Invalid link">
        <div className="grid gap-4 text-center">
          <p className="text-sm text-muted-foreground">This password-reset link is missing its token. Request a new one.</p>
          <Button type="button" onClick={() => navigate('/forgot-password')}>
            Request a new link
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Set the password for your account">
      {done ? (
        <div className="grid gap-4 text-center">
          <p className="text-sm text-muted-foreground">Your password has been updated. You can now sign in.</p>
          <Button type="button" onClick={() => navigate('/login')}>
            Go to sign in
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="pw">New password</Label>
            <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cpw">Confirm new password</Label>
            <Input id="cpw" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={submitting} className="mt-1">
            {submitting ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

/** Forced MFA enrolment (F8): shown when the org policy requires MFA and the user
 *  has not enrolled. Sets up TOTP, verifies a code, then continues into the app. */
export function EnrollMfaPage(): JSX.Element {
  const navigate = useNavigate();
  const { token, refreshSession } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    authApi.mfaSetup().then(setSetup).catch(() => setError('Could not start MFA setup.'));
  }, [token]);

  if (!token) {
    navigate('/login', { replace: true });
    return <></>;
  }

  async function verify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await authApi.mfaEnable(code);
      setBackupCodes(res.backupCodes ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function finish(): Promise<void> {
    await refreshSession();
    navigate('/', { replace: true });
  }

  return (
    <AuthShell title="Set up multi-factor authentication" subtitle="Your organisation requires MFA">
      {backupCodes ? (
        <div className="grid gap-3">
          <p className="text-sm">MFA is enabled. Save these one-time backup codes somewhere safe — each can be used once if you lose your authenticator.</p>
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted/40 p-3 text-center text-sm font-mono">
            {backupCodes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <Button type="button" onClick={finish}>Continue</Button>
        </div>
      ) : (
        <form onSubmit={verify} className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Scan or enter this key in an authenticator app (Google Authenticator, Authy, 1Password), then enter the 6-digit code.
          </p>
          {setup ? (
            <div className="grid gap-1 rounded-md bg-muted/40 p-3 text-center">
              <span className="text-xs text-muted-foreground">Setup key</span>
              <code className="break-all text-sm font-semibold">{setup.secret}</code>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Preparing setup…</p>
          )}
          <div className="grid gap-2">
            <Label htmlFor="code">Authentication code</Label>
            <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" autoFocus />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button type="submit" disabled={submitting || !setup} className="mt-1">
            {submitting ? 'Verifying…' : 'Verify and enable'}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

/** Forced change: a user who signed in with a temporary password must set a new one. */
export function SetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const { token, setInitialPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!token) {
    navigate('/login', { replace: true });
    return <></>;
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await setInitialPassword(password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set your new password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Set a new password" subtitle="Your password was reset — please choose a new one">
      <form onSubmit={submit} className="grid gap-4">
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          You signed in with a temporary password. Choose a new password to continue.
        </p>
        <div className="grid gap-2">
          <Label htmlFor="pw">New password</Label>
          <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cpw">Confirm new password</Label>
          <Input id="cpw" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={submitting} className="mt-1">
          {submitting ? 'Saving…' : 'Set password and continue'}
        </Button>
      </form>
    </AuthShell>
  );
}
