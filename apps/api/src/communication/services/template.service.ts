import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Channel } from '../providers/types';
import {
  ALL_CHANNELS,
  COMM_EVENT_LIST,
  DEFAULT_TEMPLATES,
  type CommEvent,
  type TemplateBody,
} from '../comm.events';

const MODULE = 'communication';

/**
 * The client's identity: who this deployment belongs to, and how it looks.
 *
 * WHY IT LIVES HERE. These five fields already existed under module='communication'
 * because message rendering needed the organisation's name. They are in fact app-wide
 * identity — name, logo, colour, support address — so rather than introduce a second,
 * competing branding store, this record is promoted to be THE source of truth and
 * extended. It is JSONB, so the extra fields cost no migration and older rows keep
 * working: everything added below is optional and falls back.
 */
export interface Branding {
  /* --- original five, unchanged --- */
  organizationName: string;
  logoUrl: string;
  primaryColor: string;
  supportEmail: string;
  footer: string;

  /* --- identity --- */
  /** Product name shown in the sidebar, on sign-in and in the browser tab. */
  appName?: string;
  /** Compact form for the logo tile when there is no image. */
  shortName?: string;
  /** Registered name, when it differs from the display name. */
  legalName?: string;
  tagline?: string;
  website?: string;
  supportPhone?: string;
  faviconUrl?: string;

  /* --- theme --- */
  /** Second colour, used for chart series and accents. */
  accentColor?: string;
  /** Corner rounding, mapped to --radius. */
  cornerStyle?: 'sharp' | 'default' | 'soft';

  /* --- sign-in page --- */
  /** Heading on the sign-in card. Defaults to appName. */
  welcomeTitle?: string;
  /** Line under the heading. Defaults to "Sign in to {organizationName}". */
  welcomeSubtitle?: string;
  /** Small print under the sign-in card. */
  signInFooter?: string;
}

/**
 * Deployment-level defaults from the environment, used when an administrator has not
 * set a value. Same three-tier precedence as PUBLIC_APP_URL — database, then
 * environment, then a built-in default — so there is one mental model for the whole
 * configuration surface rather than two.
 */
function envBranding(): Partial<Branding> {
  const v = (name: string): string | undefined => {
    const raw = process.env[name];
    return raw && raw.trim() ? raw.trim() : undefined;
  };
  const corner = v('BRAND_CORNER_STYLE');
  return {
    organizationName: v('BRAND_ORG_NAME'),
    appName: v('BRAND_APP_NAME'),
    shortName: v('BRAND_SHORT_NAME'),
    legalName: v('BRAND_LEGAL_NAME'),
    tagline: v('BRAND_TAGLINE'),
    logoUrl: v('BRAND_LOGO_URL'),
    faviconUrl: v('BRAND_FAVICON_URL'),
    primaryColor: v('BRAND_PRIMARY_COLOR'),
    accentColor: v('BRAND_ACCENT_COLOR'),
    supportEmail: v('BRAND_SUPPORT_EMAIL'),
    supportPhone: v('BRAND_SUPPORT_PHONE'),
    website: v('BRAND_WEBSITE'),
    footer: v('BRAND_FOOTER'),
    cornerStyle: corner === 'sharp' || corner === 'soft' || corner === 'default' ? corner : undefined,
  };
}

/** Built-in neutral defaults — deliberately carry no client's name. */
export const BRANDING_FALLBACK = {
  appName: '360 Feedback',
  organizationName: 'Your Organization',
  primaryColor: '#6d5dfc',
  accentColor: '#46c2cb',
  cornerStyle: 'default' as const,
};

export interface CommDefaults {
  /** Channels a cycle-start / event notification fans out to by default. */
  channels: Channel[];
}

export interface ResolvedTemplate extends TemplateBody {
  event: CommEvent;
  channel: Channel;
  /** True when an admin override exists; false when the built-in default is used. */
  isCustom: boolean;
}

/** Context passed to render(): a flat map of placeholder token -> value. */
export type RenderContext = Record<string, string | null | undefined>;

/**
 * Template store + placeholder renderer. Templates, branding and default channels
 * live in the generic `configurations` table (module='communication') so no schema
 * migration is required. Each template is keyed `template:{event}:{channel}`.
 */
@Injectable()
export class TemplateService {
  constructor(private readonly prisma: PrismaService) {}

  private key(event: CommEvent, channel: Channel): string {
    return `template:${event}:${channel}`;
  }

  /** Resolve the effective template for an (event, channel): override else default. */
  async resolve(orgId: string, event: CommEvent, channel: Channel): Promise<ResolvedTemplate> {
    const override = await this.readConfig<TemplateBody>(orgId, this.key(event, channel));
    const base = DEFAULT_TEMPLATES[event];
    if (override) {
      return { event, channel, isCustom: true, subject: override.subject, body: override.body, isActive: override.isActive };
    }
    return { event, channel, isCustom: false, ...base };
  }

  /**
   * Every event × channel with its resolved template (for the admin editor).
   *
   * Performance (F-P6): this looped over events × channels awaiting `resolve()` for
   * each, issuing one `configuration.findFirst` per combination — roughly 60
   * sequential round-trips to render a single settings tab. All overrides are now
   * fetched in ONE query and matched in memory; the resolution rule is identical.
   */
  async list(orgId: string): Promise<ResolvedTemplate[]> {
    const rows = await this.prisma.configuration.findMany({
      where: { organizationId: orgId, module: MODULE, key: { startsWith: 'template:' }, deletedAt: null },
      select: { key: true, value: true },
    });
    const overrides = new Map(rows.map((r) => [r.key, r.value as unknown as TemplateBody]));
    const out: ResolvedTemplate[] = [];
    for (const { event } of COMM_EVENT_LIST) {
      for (const channel of ALL_CHANNELS) {
        const override = overrides.get(this.key(event, channel));
        out.push(
          override
            ? { event, channel, isCustom: true, subject: override.subject, body: override.body, isActive: override.isActive }
            : { event, channel, isCustom: false, ...DEFAULT_TEMPLATES[event] },
        );
      }
    }
    return out;
  }

  async upsert(
    orgId: string,
    userId: string | null,
    event: CommEvent,
    channel: Channel,
    body: TemplateBody,
  ): Promise<ResolvedTemplate> {
    await this.writeConfig(orgId, userId, this.key(event, channel), {
      subject: body.subject,
      body: body.body,
      isActive: body.isActive,
    });
    return { event, channel, isCustom: true, ...body };
  }

  /** Remove an override so the built-in default takes over again. */
  async reset(orgId: string, event: CommEvent, channel: Channel): Promise<ResolvedTemplate> {
    await this.prisma.configuration.updateMany({
      where: { organizationId: orgId, module: MODULE, key: this.key(event, channel), deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return this.resolve(orgId, event, channel);
  }

  /**
   * The effective branding for an organisation.
   *
   * Precedence per field: what an administrator saved -> BRAND_* environment ->
   * the organisation's own name (for the display name only) -> a neutral default.
   * Resolving field by field rather than record by record means a client can set one
   * value in the environment and one in the UI without either erasing the other.
   */
  async branding(orgId: string): Promise<Branding> {
    const saved = await this.readConfig<Partial<Branding>>(orgId, 'branding');
    const env = envBranding();
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    const pick = (k: keyof Branding): string | undefined =>
      (saved?.[k] as string | undefined) || (env[k] as string | undefined) || undefined;

    const organizationName = pick('organizationName') || org?.name || BRANDING_FALLBACK.organizationName;
    const appName = pick('appName') || BRANDING_FALLBACK.appName;
    return {
      organizationName,
      appName,
      // `?? ''` rather than `|| undefined` for the free-text fields: an administrator
      // clearing one to blank is a deliberate choice, not a request to fall back.
      logoUrl: pick('logoUrl') ?? '',
      primaryColor: pick('primaryColor') || BRANDING_FALLBACK.primaryColor,
      accentColor: pick('accentColor') || BRANDING_FALLBACK.accentColor,
      cornerStyle: saved?.cornerStyle || env.cornerStyle || BRANDING_FALLBACK.cornerStyle,
      supportEmail: pick('supportEmail') ?? '',
      supportPhone: pick('supportPhone') ?? '',
      website: pick('website') ?? '',
      footer: pick('footer') ?? '',
      shortName: pick('shortName') || shortNameFrom(organizationName),
      legalName: pick('legalName') ?? '',
      tagline: pick('tagline') ?? '',
      faviconUrl: pick('faviconUrl') ?? '',
      welcomeTitle: saved?.welcomeTitle || appName,
      welcomeSubtitle: saved?.welcomeSubtitle || `Sign in to ${organizationName}`,
      signInFooter: saved?.signInFooter ?? '',
    };
  }

  async setBranding(orgId: string, userId: string | null, branding: Branding): Promise<Branding> {
    await this.writeConfig(orgId, userId, 'branding', branding as unknown as Record<string, unknown>);
    return this.branding(orgId);
  }

  async defaults(orgId: string): Promise<CommDefaults> {
    const value = await this.readConfig<CommDefaults>(orgId, 'defaults');
    const channels = Array.isArray(value?.channels) && value!.channels.length > 0 ? value!.channels : ['email', 'whatsapp'];
    return { channels: channels.filter((c): c is Channel => (ALL_CHANNELS as string[]).includes(c)) };
  }

  async setDefaults(orgId: string, userId: string | null, defaults: CommDefaults): Promise<CommDefaults> {
    const channels = defaults.channels.filter((c): c is Channel => (ALL_CHANNELS as string[]).includes(c));
    await this.writeConfig(orgId, userId, 'defaults', { channels });
    return { channels };
  }

  /**
   * Replace `{{token}}` occurrences with context values. Unknown or nullish tokens
   * resolve to an empty string so a recipient never sees a raw placeholder.
   */
  render(text: string, context: RenderContext): string {
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, token: string) => {
      const value = context[token];
      return value === null || value === undefined ? '' : String(value);
    });
  }

  private async readConfig<T>(orgId: string, key: string): Promise<T | null> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: MODULE, key, deletedAt: null },
      select: { value: true },
    });
    return (row?.value as T) ?? null;
  }

  private async writeConfig(orgId: string, userId: string | null, key: string, value: Record<string, unknown>): Promise<void> {
    // NB: the configurations table has a *partial* unique index (WHERE deleted_at
    // IS NULL), which Postgres will not accept for an ON CONFLICT upsert. Do a
    // manual find-then-update/create instead of prisma.upsert().
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: orgId, module: MODULE, key, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.configuration.update({
        where: { id: existing.id },
        data: { value: value as Prisma.InputJsonValue, updatedBy: userId },
      });
    } else {
      await this.prisma.configuration.create({
        data: { organizationId: orgId, module: MODULE, key, value: value as Prisma.InputJsonValue, createdBy: userId, updatedBy: userId },
      });
    }
  }
}

/**
 * A logo tile needs 2-3 characters when no image is supplied. Initials of the first
 * words beat a truncation: "ABC University" -> "ABC", "Green Valley School" -> "GVS".
 */
function shortNameFrom(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}
