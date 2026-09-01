import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/** internal (manual roster) | mock | csv (Excel/CSV upload) | generic | oneroster */
export type SisProviderKey = 'internal' | 'mock' | 'csv' | 'generic' | 'oneroster';

export interface SisIntegrationConfig {
  provider: string;
  autoSync: boolean;
  intervalHours: number;
  /** Mock-provider scenario toggle for local testing ('full' | 'reduced'). */
  mockScenario: string;
  lastSyncAt: string | null;
}

const MODULE = 'sis_integration';
const KEY = 'settings';

const DEFAULTS: SisIntegrationConfig = {
  provider: 'internal',
  autoSync: false,
  intervalHours: 24,
  mockScenario: 'full',
  lastSyncAt: null,
};

/**
 * Per-organization Student/SIS-integration settings, stored in the EXISTING
 * `configurations` table (module='sis_integration'). No new config table. Existing
 * orgs default to the Internal (manual) roster, so nothing changes until an admin
 * imports or connects a source.
 */
@Injectable()
export class SisConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string): Promise<SisIntegrationConfig> {
    const row = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: KEY, deletedAt: null },
      select: { value: true },
    });
    const stored = (row?.value ?? {}) as Partial<SisIntegrationConfig>;
    return { ...DEFAULTS, ...stored };
  }

  async patch(organizationId: string, patch: Partial<SisIntegrationConfig>): Promise<SisIntegrationConfig> {
    const current = await this.get(organizationId);
    const next: SisIntegrationConfig = { ...current, ...patch };
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId, module: MODULE, key: KEY, deletedAt: null },
      select: { id: true },
    });
    const value = next as unknown as Prisma.InputJsonValue;
    if (existing) await this.prisma.configuration.update({ where: { id: existing.id }, data: { value } });
    else await this.prisma.configuration.create({ data: { organizationId, module: MODULE, key: KEY, value } });
    return next;
  }
}
