import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Monitor, ShieldCheck, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { authApi, type SessionInfo, type MfaPolicyMode, type LockoutPolicy, type PasswordPolicy } from './api';
import { usePermissions } from './AuthContext';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';

/** Self-service security: MFA setup + active session management. */
export function SecurityPage(): JSX.Element {
  const { has } = usePermissions();
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">Two-factor authentication and active sessions.</p>
      </div>
      {has('security.rbac.manage') ? <SecurityPolicyCard /> : null}
      {has('security.rbac.manage') ? <MfaPolicyCard /> : null}
      <MfaCard />
      <SessionsCard />
    </div>
  );
}

/**
 * Organisation password + lockout policy (F2, Super Admin).
 *
 * These rules were always enforced server-side; this card is what makes them
 * changeable without a developer. Saving takes effect on the next password
 * change or sign-in attempt — existing passwords are not invalidated.
 */
function SecurityPolicyCard(): JSX.Element {
  const [password, setPassword] = useState<PasswordPolicy | null>(null);
  const [lockout, setLockout] = useState<LockoutPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    authApi
      .getSecurityPolicy()
      .then((p) => { setPassword(p.password); setLockout(p.lockout); })
      .catch(() => { setPassword(null); setLockout(null); });
  }, []);

  async function save(): Promise<void> {
    if (!password || !lockout) return;
    setSaving(true);
    try {
      const [p, l] = await Promise.all([authApi.setPasswordPolicy(password), authApi.setLockoutPolicy(lockout)]);
      setPassword(p);
      setLockout(l);
      toast.success('Security policy updated.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Failed to update security policy.');
    } finally {
      setSaving(false);
    }
  }

  const CHECKS: { key: keyof PasswordPolicy; label: string }[] = [
    { key: 'requireUpper', label: 'Require an uppercase letter' },
    { key: 'requireLower', label: 'Require a lowercase letter' },
    { key: 'requireNumber', label: 'Require a number' },
    { key: 'requireSymbol', label: 'Require a symbol' },
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-5 text-brand" />
        <h2 className="text-lg font-bold">Password &amp; lockout policy</h2>
      </div>
      <p className="mb-3 mt-1 text-sm text-muted-foreground">
        Rules applied when anyone in your organisation sets a password or signs in. Changes apply from the next
        password change or sign-in attempt; existing passwords stay valid.
      </p>
      {!password || !lockout ? <Skeleton className="h-48 w-full" /> : (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Minimum length</span>
              <Input type="number" min={6} max={64} value={password.minLength}
                onChange={(e) => setPassword({ ...password, minLength: Number(e.target.value) })} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Passwords remembered</span>
              <Input type="number" min={0} max={24} value={password.historyCount}
                onChange={(e) => setPassword({ ...password, historyCount: Number(e.target.value) })} />
              <span className="text-xs text-muted-foreground">How many previous passwords cannot be reused. 0 disables the check.</span>
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHECKS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={Boolean(password[c.key])}
                  onChange={(e) => setPassword({ ...password, [c.key]: e.target.checked })} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Failed attempts before lockout</span>
              <Input type="number" min={3} max={20} value={lockout.maxAttempts}
                onChange={(e) => setLockout({ ...lockout, maxAttempts: Number(e.target.value) })} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Lockout window (minutes)</span>
              <Input type="number" min={1} max={1440} value={lockout.windowMinutes}
                onChange={(e) => setLockout({ ...lockout, windowMinutes: Number(e.target.value) })} />
            </label>
          </div>
          <Button onClick={save} disabled={saving} className="w-fit">{saving ? 'Saving…' : 'Save policy'}</Button>
        </div>
      )}
    </Card>
  );
}

/** Organisation MFA policy (F8, Super Admin). */
function MfaPolicyCard(): JSX.Element {
  const [mode, setMode] = useState<MfaPolicyMode | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  useEffect(() => {
    authApi.getMfaPolicy().then((p) => setMode(p.mode)).catch(() => setMode('optional'));
  }, []);
  async function save(next: MfaPolicyMode): Promise<void> {
    setSaving(true);
    const prev = mode;
    setMode(next);
    try {
      await authApi.setMfaPolicy(next);
      toast.success('MFA policy updated.');
    } catch (e) {
      setMode(prev ?? 'optional');
      toast.error(e instanceof ApiError ? e.message : 'Failed to update MFA policy.');
    } finally {
      setSaving(false);
    }
  }
  const OPTIONS: { value: MfaPolicyMode; label: string; help: string }[] = [
    { value: 'optional', label: 'Optional', help: 'Each user chooses whether to enable MFA.' },
    { value: 'required_admins', label: 'Required for administrators', help: 'Users with security-admin access must enrol in MFA at next sign-in.' },
    { value: 'required_all', label: 'Required for everyone', help: 'All users must enrol in MFA at next sign-in.' },
  ];
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-5 text-brand" />
        <h2 className="text-lg font-bold">Organisation MFA policy</h2>
      </div>
      <p className="mb-3 mt-1 text-sm text-muted-foreground">Require multi-factor authentication across your organisation. Users who must enrol are guided through setup at their next sign-in.</p>
      {mode === null ? <Skeleton className="h-24 w-full" /> : (
        <div className="grid gap-2">
          {OPTIONS.map((o) => (
            <label key={o.value} className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 ${mode === o.value ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/40'}`}>
              <input type="radio" name="mfa-policy" checked={mode === o.value} disabled={saving} onChange={() => save(o.value)} className="mt-1" />
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.help}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </Card>
  );
}

function MfaCard(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    authApi.mfaStatus().then((s) => setEnabled(s.enabled));
  }, []);
  useEffect(() => load(), [load]);

  async function begin(): Promise<void> {
    setError(null);
    setSetup(await authApi.mfaSetup());
  }

  async function confirm(): Promise<void> {
    setError(null);
    try {
      const result = await authApi.mfaEnable(code);
      setBackupCodes(result.backupCodes);
      setSetup(null);
      setCode('');
      load();
    } catch {
      setError('Invalid code. Try again.');
    }
  }

  async function disable(): Promise<void> {
    await authApi.mfaDisable();
    setBackupCodes(null);
    load();
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        {enabled ? <ShieldCheck className="size-5 text-emerald-600" /> : <ShieldOff className="size-5 text-muted-foreground" />}
        <h2 className="font-bold">Two-factor authentication</h2>
        {enabled !== null ? (
          <Badge variant={enabled ? 'success' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
        ) : null}
      </div>

      {enabled === null ? <Skeleton className="h-10 w-40" /> : null}

      {enabled === false && !setup ? (
        <Button onClick={begin}>Set up authenticator</Button>
      ) : null}

      {setup ? (
        <div className="grid max-w-sm gap-3">
          <p className="text-sm text-muted-foreground">
            Add this secret to your authenticator app, then enter the current code.
          </p>
          <code className="break-all rounded-md bg-muted px-3 py-2 text-sm">{setup.secret}</code>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <div className="flex gap-2">
            <Button onClick={confirm}>Enable</Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {backupCodes ? (
        <div className="mt-3 rounded-md bg-amber-50 p-3 ring-1 ring-inset ring-amber-600/20">
          <p className="mb-2 text-sm font-semibold text-amber-800">Save your backup codes — shown once:</p>
          <div className="grid grid-cols-2 gap-1 font-mono text-sm text-amber-900 sm:grid-cols-5">
            {backupCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </div>
      ) : null}

      {enabled ? (
        <Button variant="outline" className="mt-3" onClick={disable}>
          Disable 2FA
        </Button>
      ) : null}
    </Card>
  );
}

function SessionsCard(): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);

  const load = useCallback(() => {
    authApi.listSessions().then(setSessions);
  }, []);
  useEffect(() => load(), [load]);

  async function revoke(id: string): Promise<void> {
    await authApi.revokeSession(id);
    load();
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Monitor className="size-5 text-brand" />
        <h2 className="font-bold">Active sessions</h2>
      </div>
      {!sessions ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="grid gap-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{session.userAgent ?? 'Unknown device'}</p>
                <p className="text-xs text-muted-foreground">
                  {session.ip ?? 'no ip'} · started {new Date(session.createdAt).toLocaleString()}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => revoke(session.id)}>
                Revoke
              </Button>
            </div>
          ))}
          {sessions.length === 0 ? <p className="text-sm text-muted-foreground">No active sessions.</p> : null}
        </div>
      )}
    </Card>
  );
}
