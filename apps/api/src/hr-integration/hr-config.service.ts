import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

export type OrgDataSource = 'internal' | 'external_hr';

export interface HrIntegrationConfig {
  /** Organization data source of truth. Defaults to 'internal' (no behaviour change). */
  mode: OrgDataSource;
  provider: string;
  autoSync: boolean;
  intervalHours: number;
  /** Mock-provider scenario toggle for local testing ('full' | 'reduced'). */
  mockScenario: string;
  lastSyncAt: string | null;
}

const MODULE = 'hr_integration';
const KEY = 'settings';

const DEFAULTS: HrIntegrationConfig = {
  mode: 'internal',
  provider: 'mock',
  autoSync: false,
  intervalHours: 24,
  mockScenario: 'full',
  lastSyncAt: null,
};

/**
 * Per-organization HR-integration settings, stored in the existing `configurations`
 * table (module='hr_integration'). No new config table. Existing orgs default to
 * Internal mode, so nothing changes for them until an admin opts in.
 */
@Injectable()
export class HrConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string): Promise<HrIntegrationConfig> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: KEY, deletedAt: null },
      select: { value: true },
    });
    const stored = (row?.value ?? {}) as Partial<HrIntegrationConfig>;
    return { ...DEFAULTS, ...stored };
  }

  async isExternal(organizationId: string): Promise<boolean> {
    return (await this.get(organizationId)).mode === 'external_hr';
  }

  /** Merge-patch the settings (manual upsert: the table uses a partial unique index). */
  async patch(organizationId: string, patch: Partial<HrIntegrationConfig>): Promise<HrIntegrationConfig> {
    const current = await this.get(organizationId);
    const next: HrIntegrationConfig = { ...current, ...patch };
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: KEY, deletedAt: null },
      select: { id: true },
    });
    const value = next as unknown as Prisma.InputJsonValue;
    if (existing) {
      await this.prisma.configuration.update({ where: { id: existing.id }, data: { value } });
    } else {
      await this.prisma.configuration.create({ data: { organizationId, module: MODULE, key: KEY, value } });
    }
    return next;
  }
}
