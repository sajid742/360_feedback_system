import { useEffect, useMemo, useState } from 'react';
import { Check, Monitor, RotateCcw, Save, Smartphone, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { applyBranding, useBranding, type Branding as LiveBranding } from '@/app/BrandingContext';
import { AuthShell } from '@/features/auth/AuthShell';
import { brandingApi, type BrandingRecord } from './api';

/**
 * Brand Studio — how a client's identity is configured.
 *
 * It is deliberately NOT a settings form. The proportions are inverted: the branded
 * surfaces occupy most of the width and the controls are compact strips beneath them,
 * so an administrator spends the session looking at their brand rather than at inputs.
 *
 * Two things make the preview honest rather than decorative:
 *   - the sign-in preview renders the REAL `<AuthShell>`, the same component the actual
 *     sign-in page uses, against the unsaved draft. It cannot drift from production.
 *   - edits apply to the live document immediately (`applyBranding`) so the sidebar,
 *     buttons and charts around the studio re-colour as you choose. Nothing is persisted
 *     until Save, and Discard restores what was loaded.
 */

const SECTIONS = [
  { id: 'identity', label: 'Identity', who: 'Name, logo, tagline', dot: 'var(--brand)' },
  { id: 'theme', label: 'Theme', who: 'Seen by your staff', dot: 'var(--brand-2)' },
  { id: 'signin', label: 'Sign-in', who: 'Seen by every visitor', dot: '#e0a44a' },
  { id: 'messages', label: 'Messages', who: 'Seen by parents', dot: '#3ec79a' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * Curated palettes. A small, deliberately closed set is what keeps a self-service theme
 * from producing something unprofessional — an administrator picks a pairing that was
 * designed, rather than two colours that happen to be adjacent on a picker.
 */
const PRESETS = [
  { name: 'Indigo', primary: '#6d5dfc', accent: '#46c2cb' },
  { name: 'Oxford', primary: '#0b5cab', accent: '#37a3a0' },
  { name: 'Forest', primary: '#156d5a', accent: '#b5843a' },
  { name: 'Claret', primary: '#972d4a', accent: '#4a5170' },
  { name: 'Slate', primary: '#3f4a63', accent: '#c07a3e' },
  { name: 'Ember', primary: '#b4441f', accent: '#3f6f7a' },
];

const CORNERS = [
  { id: 'sharp', label: 'Sharp', radius: '3px' },
  { id: 'default', label: 'Default', radius: '9px' },
  { id: 'soft', label: 'Soft', radius: '16px' },
] as const;

const EMPTY: BrandingRecord = {
  organizationName: '', logoUrl: '', primaryColor: '#6d5dfc', supportEmail: '', footer: '',
  appName: '', shortName: '', legalName: '', tagline: '', website: '', supportPhone: '',
  faviconUrl: '', accentColor: '#46c2cb', cornerStyle: 'default',
  welcomeTitle: '', welcomeSubtitle: '', signInFooter: '',
};

export function BrandStudioPage(): JSX.Element {
  const live = useBranding();
  const { success, error: toastError } = useToast();
  const [loaded, setLoaded] = useState<BrandingRecord | null>(null);
  const [draft, setDraft] = useState<BrandingRecord>(EMPTY);
  const [section, setSection] = useState<SectionId>('identity');
  const [surface, setSurface] = useState<'signin' | 'whatsapp' | 'email'>('signin');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    brandingApi
      .get()
      .then((b) => {
        const record = { ...EMPTY, ...b };
        setLoaded(record);
        setDraft(record);
      })
      .catch(() => {
        setLoaded(EMPTY);
        toastError('Could not load branding. Showing defaults.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => (loaded ? JSON.stringify(loaded) !== JSON.stringify(draft) : false),
    [loaded, draft],
  );

  /** What the draft actually resolves to — the same fallbacks the server applies. */
  const preview: LiveBranding = useMemo(() => {
    const orgName = draft.organizationName || live.organizationName || 'Your Organization';
    const appName = draft.appName || live.appName;
    return {
      ...live,
      organizationName: orgName,
      appName,
      shortName: draft.shortName || initials(orgName),
      tagline: draft.tagline ?? '',
      logoUrl: draft.logoUrl,
      primaryColor: draft.primaryColor || '#6d5dfc',
      accentColor: draft.accentColor || '#46c2cb',
      cornerStyle: draft.cornerStyle ?? 'default',
      supportEmail: draft.supportEmail,
      welcomeTitle: draft.welcomeTitle || appName,
      welcomeSubtitle: draft.welcomeSubtitle || `Sign in to ${orgName}`,
      signInFooter: draft.signInFooter ?? '',
    };
  }, [draft, live]);

  // Paint the whole application from the draft while the studio is open, so the choice is
  // judged in context rather than inside a small swatch.
  useEffect(() => {
    applyBranding(preview);
  }, [preview]);

  function set<K extends keyof BrandingRecord>(k: K, v: BrandingRecord[K]): void {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function discard(): void {
    if (loaded) setDraft(loaded);
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const saved = await brandingApi.save(draft);
      const record = { ...EMPTY, ...saved };
      setLoaded(record);
      setDraft(record);
      success('Branding published.');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not save branding.');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <Skeleton className="h-[32rem] w-full" />;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Brand Studio</h1>
          <p className="text-sm text-muted-foreground">
            How {preview.organizationName} appears to staff, parents and visitors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-800">
              Unpublished
            </span>
          ) : null}
          <Button variant="outline" onClick={discard} disabled={!dirty || saving}>
            <RotateCcw className="size-4" /> Discard
          </Button>
          <Button onClick={save} disabled={!dirty || saving}>
            <Save className="size-4" /> {saving ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Sections named by AUDIENCE — that is real information, not decoration: it
            tells an administrator at a glance which change is public. */}
        <nav className="grid content-start gap-1.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                section === s.id ? 'border-brand bg-card ring-2 ring-brand/15' : 'border-border bg-card hover:bg-muted/40'
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-bold tracking-tight">
                <span className="size-1.5 rounded-full" style={{ background: s.dot }} />
                {s.label}
              </span>
              <span className="block pl-3.5 text-xs text-muted-foreground">{s.who}</span>
            </button>
          ))}
        </nav>

        <div className="grid content-start gap-4">
          {section === 'identity' ? <IdentitySection draft={draft} set={set} preview={preview} /> : null}
          {section === 'theme' ? <ThemeSection draft={draft} set={set} /> : null}
          {section === 'signin' ? <SignInSection draft={draft} set={set} /> : null}
          {section === 'messages' ? <MessagesSection draft={draft} set={set} /> : null}

          <Card className="grid gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold tracking-tight">Preview as a visitor</h2>
              <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
                {([
                  ['signin', 'Sign-in', Monitor],
                  ['whatsapp', 'WhatsApp', Smartphone],
                  ['email', 'Email', Mail],
                ] as const).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    onClick={() => setSurface(id)}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      surface === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-border">
              {surface === 'signin' ? <SignInPreview branding={preview} /> : null}
              {surface === 'whatsapp' ? <WhatsAppPreview branding={preview} /> : null}
              {surface === 'email' ? <EmailPreview branding={preview} draft={draft} /> : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sections */

type Setter = <K extends keyof BrandingRecord>(k: K, v: BrandingRecord[K]) => void;

function IdentitySection({ draft, set, preview }: { draft: BrandingRecord; set: Setter; preview: LiveBranding }): JSX.Element {
  return (
    <Card className="grid gap-4 p-4">
      <h2 className="text-sm font-bold tracking-tight">Brand identity</h2>

      {/* A brand sheet, not a row of inputs — the administrator sees the result first. */}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center gap-3 p-4" style={{ background: 'var(--auth-gradient)' }}>
          {preview.logoUrl ? (
            <img src={preview.logoUrl} alt="" className="h-12 max-w-[9rem] object-contain" />
          ) : (
            <span
              className="flex size-12 items-center justify-center rounded-xl text-base font-extrabold text-white"
              style={{ background: `linear-gradient(135deg, ${preview.primaryColor}, ${preview.accentColor})` }}
            >
              {preview.shortName}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-base font-bold tracking-tight text-white">{preview.organizationName}</p>
            <p className="truncate text-xs text-white/70">{preview.tagline || preview.appName}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-border">
          <Cell k="Short name" v={preview.shortName} />
          <Cell k="Application name" v={preview.appName} />
          <Cell k="Support" v={draft.supportEmail || '—'} />
          <Cell k="Website" v={draft.website || '—'} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <F label="Organization name">
          <Input value={draft.organizationName} onChange={(e) => set('organizationName', e.target.value)} placeholder="ABC University" />
        </F>
        <F label="Application name" hint="Shown in the sidebar and browser tab">
          <Input value={draft.appName ?? ''} onChange={(e) => set('appName', e.target.value)} placeholder="360 Feedback System" />
        </F>
        <F label="Short name" hint="Used on the logo tile when there is no image">
          <Input value={draft.shortName ?? ''} onChange={(e) => set('shortName', e.target.value)} placeholder={initials(draft.organizationName || 'ABC')} />
        </F>
        <F label="Legal name" hint="Only if it differs from the display name">
          <Input value={draft.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} />
        </F>
        <F label="Tagline" hint="Appears under the name on sign-in">
          <Input value={draft.tagline ?? ''} onChange={(e) => set('tagline', e.target.value)} placeholder="Comprehensive performance feedback and development" />
        </F>
        <F label="Website">
          <Input value={draft.website ?? ''} onChange={(e) => set('website', e.target.value)} placeholder="abc.edu" />
        </F>
      </div>

      <LogoField draft={draft} set={set} />
    </Card>
  );
}

function ThemeSection({ draft, set }: { draft: BrandingRecord; set: Setter }): JSX.Element {
  const active = PRESETS.find((p) => p.primary.toLowerCase() === (draft.primaryColor ?? '').toLowerCase());
  return (
    <Card className="grid gap-4 p-4">
      <div>
        <h2 className="text-sm font-bold tracking-tight">Theme</h2>
        <p className="text-xs text-muted-foreground">
          Pick a palette by seeing what your feedback reports will look like. Light and dark shades,
          the sidebar and the chart accent are derived from your primary colour.
        </p>
      </div>

      {/* Presets carry the product's own signature graphic rather than paint chips. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {PRESETS.map((p) => {
          const on = active?.name === p.name;
          return (
            <button
              key={p.name}
              onClick={() => { set('primaryColor', p.primary); set('accentColor', p.accent); }}
              className={`grid justify-items-center gap-1.5 rounded-lg border p-2.5 transition-colors ${
                on ? 'border-brand ring-2 ring-brand/15' : 'border-border hover:bg-muted/40'
              }`}
            >
              <RadarMark primary={p.primary} accent={p.accent} />
              <span className="text-[11px] font-semibold">{p.name}</span>
              <span className="flex gap-1">
                <span className="size-3 rounded" style={{ background: p.primary }} />
                <span className="size-3 rounded" style={{ background: p.accent }} />
              </span>
              {on ? <Check className="size-3 text-brand" /> : null}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <F label="Primary colour" hint="Buttons, links, sidebar and the first chart series">
          <div className="flex items-center gap-2">
            <input type="color" value={draft.primaryColor || '#6d5dfc'} onChange={(e) => set('primaryColor', e.target.value)} className="h-10 w-12 rounded-md border border-input" aria-label="Primary colour" />
            <Input value={draft.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} className="max-w-[130px] font-mono text-xs" />
          </div>
        </F>
        <F label="Accent colour" hint="Second chart series and highlights">
          <div className="flex items-center gap-2">
            <input type="color" value={draft.accentColor || '#46c2cb'} onChange={(e) => set('accentColor', e.target.value)} className="h-10 w-12 rounded-md border border-input" aria-label="Accent colour" />
            <Input value={draft.accentColor ?? ''} onChange={(e) => set('accentColor', e.target.value)} className="max-w-[130px] font-mono text-xs" />
          </div>
        </F>
      </div>

      <F label="Corner style">
        <div className="flex gap-2">
          {CORNERS.map((c) => (
            <button
              key={c.id}
              onClick={() => set('cornerStyle', c.id)}
              style={{ borderRadius: c.radius }}
              className={`flex-1 border px-3 py-2 text-xs font-semibold transition-colors ${
                (draft.cornerStyle ?? 'default') === c.id ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/40'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </F>

      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3">
        <span className="text-xs font-semibold text-muted-foreground">Live:</span>
        <Button size="sm">Primary action</Button>
        <Button size="sm" variant="outline">Secondary</Button>
        <span className="rounded-full px-2.5 py-1 text-[11px] font-bold text-white" style={{ background: draft.primaryColor }}>Badge</span>
        <span className="rounded-full px-2.5 py-1 text-[11px] font-bold text-white" style={{ background: draft.accentColor }}>Accent</span>
      </div>
    </Card>
  );
}

function SignInSection({ draft, set }: { draft: BrandingRecord; set: Setter }): JSX.Element {
  return (
    <Card className="grid gap-3 p-4">
      <div>
        <h2 className="text-sm font-bold tracking-tight">Sign-in page</h2>
        <p className="text-xs text-muted-foreground">The first thing every visitor sees. Leave a field blank to use a sensible default.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <F label="Welcome title" hint="Defaults to the application name">
          <Input value={draft.welcomeTitle ?? ''} onChange={(e) => set('welcomeTitle', e.target.value)} placeholder={draft.appName || '360 Feedback System'} />
        </F>
        <F label="Subtitle" hint="Defaults to “Sign in to <organisation>”">
          <Input value={draft.welcomeSubtitle ?? ''} onChange={(e) => set('welcomeSubtitle', e.target.value)} />
        </F>
      </div>
      <F label="Footer note" hint="Small print under the card. Defaults to your support email.">
        <Input value={draft.signInFooter ?? ''} onChange={(e) => set('signInFooter', e.target.value)} placeholder="Need help? support@abc.edu" />
      </F>
      <F label="Support email">
        <Input value={draft.supportEmail} onChange={(e) => set('supportEmail', e.target.value)} placeholder="support@abc.edu" />
      </F>
    </Card>
  );
}

function MessagesSection({ draft, set }: { draft: BrandingRecord; set: Setter }): JSX.Element {
  return (
    <Card className="grid gap-3 p-4">
      <div>
        <h2 className="text-sm font-bold tracking-tight">How you appear to recipients</h2>
        <p className="text-xs text-muted-foreground">
          Applies to parent invitations, password resets and reminders. Server addresses, keys and
          providers stay in <span className="font-medium text-foreground">Communication → Providers</span>.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <F label="Display name" hint="The organisation name recipients see in messages">
          <Input value={draft.organizationName} onChange={(e) => set('organizationName', e.target.value)} />
        </F>
        <F label="Support phone">
          <Input value={draft.supportPhone ?? ''} onChange={(e) => set('supportPhone', e.target.value)} placeholder="+92 51 000 0000" />
        </F>
      </div>
      <F label="Signature / footer" hint="Closing line on outgoing email">
        <Textarea value={draft.footer} onChange={(e) => set('footer', e.target.value)} placeholder="ABC University · People & Performance · support@abc.edu" />
      </F>
    </Card>
  );
}

/* ------------------------------------------------------------------ previews */

function SignInPreview({ branding }: { branding: LiveBranding }): JSX.Element {
  // The REAL AuthShell, against the draft. The preview cannot drift from the live page
  // because it is the same component; only the form inside is inert.
  return (
    <div className="pointer-events-none">
      <AuthShell branding={branding} heightClass="min-h-[26rem]">
        <div className="grid gap-4">
          <FakeField label="Organization" value={branding.defaultOrgSlug || 'your-org'} />
          <FakeField label="Email" value="" />
          <FakeField label="Password" value="" />
          <div className="mt-1 flex h-10 items-center justify-center rounded-md bg-gradient-to-br from-brand to-brand-dark text-sm font-semibold text-white">
            Sign in
          </div>
          <p className="text-center text-sm text-brand">Forgot password?</p>
        </div>
      </AuthShell>
    </div>
  );
}

function WhatsAppPreview({ branding }: { branding: LiveBranding }): JSX.Element {
  return (
    <div className="grid place-items-center bg-[#e9ebf3] p-6" style={{ minHeight: 260 }}>
      <div className="max-w-[19rem] rounded-xl rounded-bl-sm bg-white p-3 text-[13px] leading-relaxed shadow-md">
        Dear Parent/Guardian,
        <br />
        <br />
        {branding.organizationName} invites you to rate Ayesha Khan&rsquo;s three teachers — one short
        question each, on a single form.
        <span className="mt-2 block break-all font-semibold" style={{ color: branding.primaryColor }}>
          https://360.example.com/evaluate/ys4Oir…
        </span>
        <span className="mt-1 block text-right text-[10px] text-muted-foreground">09:24 ✓✓</span>
      </div>
    </div>
  );
}

function EmailPreview({ branding, draft }: { branding: LiveBranding; draft: BrandingRecord }): JSX.Element {
  return (
    <div className="bg-white" style={{ minHeight: 260 }}>
      <div className="flex items-center gap-3 border-b border-border p-4">
        {branding.logoUrl ? (
          <img src={branding.logoUrl} alt="" className="h-8 max-w-[7rem] object-contain" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-lg text-xs font-extrabold text-white" style={{ background: branding.primaryColor }}>
            {branding.shortName}
          </span>
        )}
        <div>
          <p className="text-sm font-bold tracking-tight">{branding.organizationName}</p>
          <p className="text-xs text-muted-foreground">teacher evaluation</p>
        </div>
      </div>
      <div className="p-4 text-[13px] leading-relaxed text-muted-foreground">
        <p>Dear Parent/Guardian,</p>
        <p className="mt-2">
          {branding.organizationName} invites you to evaluate Imran Farooqi for Mathematics taught to
          Ayesha Khan.
        </p>
        <p className="mt-2">Please complete the short evaluation using the link below:</p>
        <span className="mt-2 inline-block rounded-lg px-4 py-2 text-xs font-semibold text-white" style={{ background: branding.primaryColor }}>
          Open the feedback form
        </span>
        <p className="mt-4 border-t border-border pt-3 text-xs">
          {draft.footer || `${branding.organizationName}${branding.supportEmail ? ` · ${branding.supportEmail}` : ''}`}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ bits */

function LogoField({ draft, set }: { draft: BrandingRecord; set: Setter }): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  /**
   * Read the file straight into a data: URI stored in the branding record. This is the
   * deliberate alternative to building an upload endpoint, object storage and a volume
   * for one small image per client — at this size the picture rides in the JSONB row.
   */
  function onFile(file: File | undefined): void {
    if (!file) return;
    if (!/^image\/(png|jpeg|svg\+xml|webp|gif)$/.test(file.type)) {
      setError('Use a PNG, JPEG, SVG, WebP or GIF image.');
      return;
    }
    if (file.size > 150 * 1024) {
      setError(`That file is ${Math.round(file.size / 1024)} KB. Use one under 150 KB — a logo rarely needs more.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setError(null); set('logoUrl', String(reader.result)); };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsDataURL(file);
  }

  return (
    <F label="Logo" hint="Upload an image, or paste a URL. Leave empty to use the initials tile.">
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md border border-input bg-card px-3 py-2 text-xs font-semibold hover:bg-muted/40">
          Choose image
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <Input
          value={draft.logoUrl.startsWith('data:') ? '' : draft.logoUrl}
          onChange={(e) => set('logoUrl', e.target.value)}
          placeholder={draft.logoUrl.startsWith('data:') ? 'Uploaded image' : 'https://…/logo.svg'}
          className="max-w-xs"
        />
        {draft.logoUrl ? (
          <Button variant="outline" size="sm" onClick={() => set('logoUrl', '')}>Remove</Button>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </F>
  );
}

/** The signature graphic of a 360 platform, at thumbnail size. */
function RadarMark({ primary, accent }: { primary: string; accent: string }): JSX.Element {
  return (
    <svg width="58" height="46" viewBox="0 0 58 46" aria-hidden="true">
      <polygon points="29,5 51,18 43,41 15,41 7,18" fill="none" stroke="currentColor" strokeWidth="1" className="text-border" />
      <polygon points="29,14 42,21 38,34 20,34 15,21" fill={primary} fillOpacity="0.2" stroke={primary} strokeWidth="1.5" />
      <polygon points="29,10 46,20 40,37 18,36 12,20" fill="none" stroke={accent} strokeWidth="1.3" strokeDasharray="3 2" />
    </svg>
  );
}

function Cell({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k}</p>
      <p className="truncate text-sm font-semibold">{v}</p>
    </div>
  );
}

function F({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function FakeField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex h-10 items-center rounded-md border border-input bg-card px-3 text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return '360';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}
