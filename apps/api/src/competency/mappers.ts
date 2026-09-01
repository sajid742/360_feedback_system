import type {
  BehaviourIndicator,
  Competency,
  CompetencyCategory,
  CompetencyVersion,
  ProficiencyLevel,
} from '@prisma/client';

/**
 * Serializers from Prisma rows to API DTOs. Single source of truth for the
 * response shapes the frontend consumes (DRY). Kept free of business logic.
 */

type CategoryRow = CompetencyCategory & { _count?: { competencies: number } };

export function serializeCategory(row: CategoryRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    colorTone: row.colorTone,
    competencyCount: row._count?.competencies ?? 0,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function serializeIndicator(row: BehaviourIndicator): Record<string, unknown> {
  return {
    id: row.id,
    versionId: row.versionId,
    type: row.type,
    proficiencyLevelId: row.proficiencyLevelId,
    text: row.text,
    sortOrder: row.sortOrder,
  };
}

type VersionRow = CompetencyVersion & {
  proficiencyLevels: ProficiencyLevel[];
  indicators: BehaviourIndicator[];
};

export function serializeVersion(row: VersionRow): Record<string, unknown> {
  return {
    id: row.id,
    competencyId: row.competencyId,
    versionLabel: row.versionLabel,
    status: row.status,
    proficiencyLevels: row.proficiencyLevels
      .slice()
      .sort((a, b) => a.level - b.level)
      .map((level) => ({
        id: level.id,
        level: level.level,
        name: level.name,
        description: level.description,
      })),
    indicators: row.indicators.map(serializeIndicator),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type CompetencyRow = Competency & {
  category: CompetencyCategory;
  versions: VersionRow[];
  _count?: { versions: number };
  mappings?: { isMandatory: boolean }[];
};

export function serializeCompetency(row: CompetencyRow): Record<string, unknown> {
  const activeVersion = row.versions.find((v) => v.status === 'active') ?? null;
  const latestVersion = [...row.versions].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];

  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: row.category.name,
    name: row.name,
    description: row.description,
    activeVersion: activeVersion ? serializeVersion(activeVersion) : null,
    latestVersion: latestVersion ? serializeVersion(latestVersion) : null,
    versionCount: row._count?.versions ?? row.versions.length,
    isMandatoryAnywhere: (row.mappings ?? []).some((m) => m.isMandatory),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
