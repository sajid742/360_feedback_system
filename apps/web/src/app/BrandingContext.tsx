import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * Client branding, fetched once before anything renders.
 *
 * WHY IT IS FETCHED RATHER THAN BUILT IN. The sign-in page has to show the client's
 * name, logo and colour before anyone has authenticated. Baking those into the bundle
 * (as `VITE_DEFAULT_ORG_SLUG` used to do) means one web image per client and a rebuild
 * every time a client changes their logo. Reading them at boot means one image serves
 * every client, and a change takes effect on refresh.
 */
export interface Branding {
  defaultOrgSlug: string;
  appName: string;
  organizationName: string;
  shortName: string;
  tagline: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  accentColor: string;
  cornerStyle: 'sharp' | 'default' | 'soft';
  supportEmail: string;
  supportPhone: string;
  website: string;
  welcomeTitle: string;
  welcomeSubtitle: string;
  signInFooter: string;
}

/** Neutral, client-free defaults used until the fetch lands (and if it fails). */
export const FALLBACK_BRANDING: Branding = {
  defaultOrgSlug: '',
  appName: '360 Feedback',
  organizationName: '',
  shortName: '360',
  tagline: '',
  logoUrl: '',
  faviconUrl: '',
  primaryColor: '#6d5dfc',
  accentColor: '#46c2cb',
  cornerStyle: 'default',
  supportEmail: '',
  supportPhone: '',
  website: '',
  welcomeTitle: '360 Feedback',
  welcomeSubtitle: 'Sign in to your workspace',
  signInFooter: '',
};

const BrandingContext = createContext<{ branding: Branding; ready: boolean }>({
  branding: FALLBACK_BRANDING,
  ready: false,
});

export function useBranding(): Branding {
  return useContext(BrandingContext).branding;
}

/* ------------------------------------------------------------------ theme */

const RADIUS: Record<Branding['cornerStyle'], string> = {
  sharp: '0.25rem',
  default: '0.75rem',
  soft: '1.25rem',
};

/** #rrggbb -> {r,g,b}; returns null for anything else so callers can bail safely. */
function rgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Move a colour toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
  const c = rgb(hex);
  if (!c) return hex;
  const mix = (v: number): number =>
    Math.round(amount > 0 ? v + (255 - v) * amount : v * (1 + amount));
  const h = (v: number): string => Math.max(0, Math.min(255, mix(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * Apply branding to the live document.
 *
 * The CSS custom properties this writes have existed since the first build
 * (index.css) and Tailwind already maps them — what was missing was anything that
 * ever wrote them. An administrator picks ONE colour and the ramp, the sidebar
 * gradient and the chart accent are derived from it, which is what keeps a
 * self-service theme from producing something unprofessional.
 */
export function applyBranding(b: Branding): void {
  const root = document.documentElement;
  const set = (k: string, v: string): void => root.style.setProperty(k, v);

  if (rgb(b.primaryColor)) {
    set('--brand', b.primaryColor);
    set('--brand-light', shade(b.primaryColor, 0.28));
    set('--brand-dark', shade(b.primaryColor, -0.22));
    // The sidebar and the sign-in ground are the same deep, heavily-darkened brand, so
    // the whole application shifts from the single choice rather than drifting apart.
    set('--sidebar-gradient', `linear-gradient(180deg, ${shade(b.primaryColor, -0.78)}, ${shade(b.primaryColor, -0.66)})`);
    set('--auth-gradient', `linear-gradient(135deg, ${shade(b.primaryColor, -0.78)}, ${shade(b.primaryColor, -0.66)})`);
  }
  if (rgb(b.accentColor)) set('--brand-2', b.accentColor);
  set('--radius', RADIUS[b.cornerStyle] ?? RADIUS.default);

  document.title = b.organizationName ? `${b.appName} · ${b.organizationName}` : b.appName;

  // Favicon: replace rather than append, so repeated calls (the Brand Studio preview
  // re-applies on every keystroke) cannot pile up <link> tags.
  const href = b.faviconUrl || svgFavicon(b);
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

/** With no favicon supplied, draw the logo tile — the client's initials on brand. */
function svgFavicon(b: Branding): string {
  const initials = (b.shortName || '360').slice(0, 3);
  const size = initials.length > 2 ? 26 : 34;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${b.primaryColor}"/>` +
    `<text x="32" y="32" font-family="Inter,Arial,sans-serif" font-size="${size}" font-weight="800" ` +
    `fill="#fff" text-anchor="middle" dominant-baseline="central">${escapeXml(initials)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------ provider */

export function BrandingProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [branding, setBranding] = useState<Branding>(FALLBACK_BRANDING);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Partial<Branding>>('/public/branding')
      .then((b) => {
        if (cancelled) return;
        const merged = { ...FALLBACK_BRANDING, ...b } as Branding;
        setBranding(merged);
        applyBranding(merged);
      })
      // A branding fetch must never keep anyone out of the application. On failure the
      // neutral defaults stand and sign-in still works.
      .catch(() => undefined)
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ branding, ready }), [branding, ready]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}
