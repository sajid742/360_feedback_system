import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface ProficiencyLevelSeed {
  level: number;
  name: string;
  description: string | null;
}

interface ConfigRow {
  value: unknown;
}

/**
 * Resolves the organization's DEFAULT proficiency scale used to seed a new
 * competency's v1 draft. The scale is DATA, read from the generic
 * `configurations` table (module='competency', key='default_proficiency_scale')
 * — never hardcoded (PROMPTS.md: "Never hardcode Rating Scale").
 *
 * If nothing is configured the seed is empty; the version is created with zero
 * proficiency levels and an administrator defines them (or configures a default)
 * later. A raw query is used so this does not couple to the Configuration
 * module's Prisma model name.
 */
@Injectable()
export class ProficiencyScaleService {
  private readonly logger = new Logger(ProficiencyScaleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveDefault(organizationId: string): Promise<ProficiencyLevelSeed[]> {
    try {
      const rows = await this.prisma.$queryRaw<ConfigRow[]>`
        SELECT value
        FROM configurations
        WHERE organization_id = ${organizationId}::uuid
          AND module = 'competency'
          AND key = 'default_proficiency_scale'
          AND deleted_at IS NULL
        LIMIT 1
      `;
      return this.parse(rows[0]?.value);
    } catch (error) {
      this.logger.warn(`Could not resolve default proficiency scale: ${(error as Error).message}`);
      return [];
    }
  }

  private parse(value: unknown): ProficiencyLevelSeed[] {
    const raw = typeof value === 'string' ? this.safeJson(value) : value;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry, index) => ({
        level: typeof entry.level === 'number' ? entry.level : index + 1,
        name: String(entry.name ?? `Level ${index + 1}`),
        description: entry.description == null ? null : String(entry.description),
      }))
      .filter((entry) => entry.level > 0);
  }

  private safeJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
}
