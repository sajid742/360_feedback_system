import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/auth/current-user';

export interface CompetencyStats {
  totalCompetencies: number;
  activeCompetencies: number;
  categories: number;
  draftVersions: number;
}

/*
 * `mappedDesignations` was removed from this summary.
 *
 * It counted the distinct designations appearing in `competency_designation_mappings`
 * — a competency↔job-title link carrying a weight and a mandatory flag. That table is
 * still there and still correct, but NOTHING in the product writes to it: there is no
 * endpoint and no screen, so the only rows that ever existed came from the demo seed,
 * and a real client would always have seen zero. It also fed nothing: competencies are
 * assessed through Quadrant → Questionnaire → Questions → Competencies, which is
 * derived from the questionnaire and never consults designation at all.
 *
 * The table is deliberately kept as groundwork for role-based competency profiles. If
 * that feature is built, restore this count alongside the write path — not before.
 */

/** Aggregates the Competency module KPIs for the stats row. All counts are
 *  tenant-scoped and exclude soft-deleted rows. */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: AuthUser): Promise<CompetencyStats> {
    const org = user.organizationId;
    const [totalCompetencies, activeCompetencies, categories, draftVersions] =
      await this.prisma.$transaction([
        this.prisma.competency.count({ where: { organizationId: org, deletedAt: null } }),
        this.prisma.competency.count({
          where: { organizationId: org, deletedAt: null, versions: { some: { status: 'active' } } },
        }),
        this.prisma.competencyCategory.count({ where: { organizationId: org, deletedAt: null } }),
        this.prisma.competencyVersion.count({
          where: { organizationId: org, deletedAt: null, status: 'draft' },
        }),
      ]);

    return {
      totalCompetencies,
      activeCompetencies,
      categories,
      draftVersions,
    };
  }
}
