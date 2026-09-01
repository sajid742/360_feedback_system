import { apiClient } from '@/lib/api-client';

/**
 * The client's branding record, exactly as stored.
 *
 * Deliberately the RAW record rather than the resolved one: the studio must show what an
 * administrator actually set, with blanks staying blank, so that saving cannot silently
 * freeze a fallback into the database. (The same mistake once froze
 * `http://localhost:5173` into the public URL setting.) The resolved values, with
 * fallbacks applied, come from `/public/branding` via BrandingContext.
 */
export interface BrandingRecord {
  organizationName: string;
  logoUrl: string;
  primaryColor: string;
  supportEmail: string;
  footer: string;
  appName?: string;
  shortName?: string;
  legalName?: string;
  tagline?: string;
  website?: string;
  supportPhone?: string;
  faviconUrl?: string;
  accentColor?: string;
  cornerStyle?: 'sharp' | 'default' | 'soft';
  welcomeTitle?: string;
  welcomeSubtitle?: string;
  signInFooter?: string;
}

export const brandingApi = {
  get: async (): Promise<BrandingRecord> => {
    const s = await apiClient.get<{ branding: BrandingRecord }>('/communication/settings');
    return s.branding;
  },
  save: (input: BrandingRecord): Promise<BrandingRecord> =>
    apiClient.post('/communication/settings/branding', input),
};
