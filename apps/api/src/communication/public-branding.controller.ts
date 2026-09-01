import { Controller, Get, Header, Query } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BRANDING_FALLBACK, TemplateService, type Branding } from './services/template.service';

/**
 * The only branding a browser can read WITHOUT signing in.
 *
 * This exists because the sign-in page has to be branded before anyone has
 * authenticated — that is the whole point of a white-labelled deployment — and until
 * now nothing about an organisation was reachable pre-auth.
 *
 * THREE RULES SHAPE IT, and all three are security-relevant:
 *
 *   1. Presentation fields only. Nothing operational, no provider settings, no webhook
 *      secret, no counts, no e-mail addresses beyond the support address the client
 *      publishes anyway.
 *
 *   2. An unknown slug is NOT an error. It returns the deployment defaults with the
 *      same shape and the same 200 as a real one. Were it to 404, this endpoint would
 *      become an oracle any anonymous caller could use to enumerate which clients are
 *      hosted here — a genuine disclosure for a multi-tenant install.
 *
 *   3. Cacheable. The sign-in page calls it on every load, and branding changes rarely.
 */
@Controller('public/branding')
export class PublicBrandingController {
  constructor(
    private readonly templates: TemplateService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async get(@Query('org') org?: string): Promise<Record<string, unknown>> {
    const slug = normaliseSlug(org) ?? normaliseSlug(process.env.DEFAULT_ORG_SLUG);
    const branding = slug ? await this.forSlug(slug) : null;
    return publicView(branding, slug ?? '');
  }

  /** Resolve a slug to its branding, or null when it names nothing. */
  private async forSlug(slug: string): Promise<Branding | null> {
    const org = await this.prisma.organization.findFirst({
      where: { slug, orgType: 'root', deletedAt: null },
      select: { id: true },
    });
    return org ? this.templates.branding(org.id) : null;
  }
}

/** Slugs are lowercase alphanumeric-with-hyphens; anything else names nothing. */
function normaliseSlug(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/.test(s) ? s : undefined;
}

/**
 * The whitelist. Written as an explicit projection rather than a delete-list so a field
 * added to `Branding` later is private until someone deliberately publishes it here.
 */
function publicView(b: Branding | null, slug: string): Record<string, unknown> {
  const env = (name: string, fallback = ''): string => (process.env[name] ?? '').trim() || fallback;
  const appName = b?.appName || env('BRAND_APP_NAME', BRANDING_FALLBACK.appName);
  const organizationName = b?.organizationName || env('BRAND_ORG_NAME', BRANDING_FALLBACK.organizationName);
  return {
    defaultOrgSlug: normaliseSlug(process.env.DEFAULT_ORG_SLUG) ?? slug,
    appName,
    organizationName,
    shortName: b?.shortName || env('BRAND_SHORT_NAME') || organizationName.slice(0, 3).toUpperCase(),
    tagline: b?.tagline || env('BRAND_TAGLINE'),
    logoUrl: b?.logoUrl || env('BRAND_LOGO_URL'),
    faviconUrl: b?.faviconUrl || env('BRAND_FAVICON_URL'),
    primaryColor: b?.primaryColor || env('BRAND_PRIMARY_COLOR', BRANDING_FALLBACK.primaryColor),
    accentColor: b?.accentColor || env('BRAND_ACCENT_COLOR', BRANDING_FALLBACK.accentColor),
    cornerStyle: b?.cornerStyle || BRANDING_FALLBACK.cornerStyle,
    supportEmail: b?.supportEmail || env('BRAND_SUPPORT_EMAIL'),
    supportPhone: b?.supportPhone || env('BRAND_SUPPORT_PHONE'),
    website: b?.website || env('BRAND_WEBSITE'),
    welcomeTitle: b?.welcomeTitle || appName,
    welcomeSubtitle: b?.welcomeSubtitle || `Sign in to ${organizationName}`,
    signInFooter: b?.signInFooter ?? '',
  };
}
