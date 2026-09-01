import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient, ApiError } from '@/lib/api-client';
import { AuthShellLive } from '@/features/auth/AuthShell';

interface ProvisioningStatus {
  needsSetup: boolean;
  canProvision: boolean;
  keyConfigured: boolean;
  organizations: number;
}

interface ProvisionResult {
  slug: string;
  email: string;
  created: boolean;
  rolesSeeded: number;
  starterContent?: { skipped?: boolean; ratingScales?: number; competencies?: number; questions?: number; templates?: number };
}

/** Derive a valid sign-in code from the organisation name as the admin types it. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Organisation setup wizard (F22).
 *
 * Replaces "ask a developer to run the bootstrap CLI on the server". On a fresh
 * installation this is the first-run wizard and is open, because there is no data
 * to protect yet. Once at least one organisation exists it becomes the operator's
 * console for adding further tenants and requires the platform provisioning key.
 */
export function SetupPage(): JSX.Element {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ProvisioningStatus | null>(null);
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [withStarterContent, setWithStarterContent] = useState(true);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  useEffect(() => {
    apiClient
      .get<ProvisioningStatus>('/provisioning/status')
      .then(setStatus)
      .catch(() => setStatus({ needsSetup: false, canProvision: false, keyConfigured: false, organizations: 0 }));
  }, []);

  const effectiveSlug = slugTouched ? slug : slugify(orgName);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const created = await apiClient.post<ProvisionResult>(
        '/provisioning/organizations',
        { orgName: orgName.trim(), slug: effectiveSlug, email: email.trim(), password, withStarterContent },
        // The provisioning key is an operator credential, not a session token.
        status?.needsSetup ? undefined : { headers: { 'X-Provisioning-Key': key } },
      );
      setResult(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the organisation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShellLive
      width="max-w-lg"
      title={status?.needsSetup ? 'Set up your organisation' : 'Add an organisation'}
      subtitle=""
    >
      <div>
        <div className="mb-6 text-center">
          <h1 className="sr-only">
            {status?.needsSetup ? 'Set up your organisation' : 'Add an organisation'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {status?.needsSetup
              ? 'Create your organisation and its first administrator. This takes about a minute.'
              : 'Create an additional tenant on this installation.'}
          </p>
        </div>

        {!status ? (
          <Skeleton className="h-64 w-full" />
        ) : result ? (
          <div className="grid gap-4 text-sm">
            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
              <p className="font-semibold">Organisation ready.</p>
              <p className="mt-1">
                {result.rolesSeeded} roles created
                {result.starterContent && !result.starterContent.skipped
                  ? `, plus a rating scale, ${result.starterContent.competencies} competencies and a published questionnaire so you can run a cycle straight away.`
                  : '.'}
              </p>
            </div>
            <dl className="grid gap-1 rounded-md bg-muted/50 p-4">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Sign-in code</dt>
                <dd className="font-mono font-medium">{result.slug}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Administrator</dt>
                <dd className="font-medium">{result.email}</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              Sign in with the sign-in code, the administrator email, and the password you just chose.
            </p>
            <Button onClick={() => navigate('/login')}>Go to sign in</Button>
          </div>
        ) : !status.canProvision ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-semibold">Provisioning is disabled.</p>
            <p className="mt-1">
              This installation is already set up. To add more organisations, set{' '}
              <code className="font-mono">PLATFORM_PROVISIONING_KEY</code> on the server and reload this page.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="setup-org">Organisation name</Label>
              <Input id="setup-org" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Your organisation\u2019s name" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="setup-slug">Sign-in code</Label>
              <Input
                id="setup-slug"
                value={effectiveSlug}
                onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }}
                placeholder="your-org"
                required
              />
              <p className="text-xs text-muted-foreground">Everyone in your organisation enters this on the sign-in screen. Lowercase letters, numbers and hyphens.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="setup-email">Administrator email</Label>
              <Input id="setup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@your-org.com" required />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="setup-pw">Password</Label>
                <Input id="setup-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="setup-pw2">Confirm password</Label>
                <Input id="setup-pw2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={10} required />
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={withStarterContent} onChange={(e) => setWithStarterContent(e.target.checked)} className="mt-1" />
              <span>
                Add starter content
                <span className="block text-xs text-muted-foreground">A rating scale, sample competencies and a published questionnaire, so a feedback cycle can be created immediately. You can edit or replace all of it later.</span>
              </span>
            </label>
            {!status.needsSetup ? (
              <div className="grid gap-1.5">
                <Label htmlFor="setup-key">Provisioning key</Label>
                <Input id="setup-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} required />
                <p className="text-xs text-muted-foreground">The <code className="font-mono">PLATFORM_PROVISIONING_KEY</code> configured on the server.</p>
              </div>
            ) : null}
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create organisation'}</Button>
          </form>
        )}
      </div>
    </AuthShellLive>
  );
}
