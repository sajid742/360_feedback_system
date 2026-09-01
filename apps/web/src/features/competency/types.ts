/**
 * Competency domain types. These mirror the backend DTOs / Prisma models
 * (camelCased). Kept in the feature until promoted to packages/shared-types;
 * the shapes intentionally match the API_CONTRACT envelope's `data` payloads.
 *
 * NOTE: proficiency levels and rating scales are DATA (fetched from config /
 * the competency version), never hardcoded here (PROMPTS.md).
 */

export type VersionStatus = 'draft' | 'active' | 'retired';
export type IndicatorType = 'positive' | 'negative';

export interface CompetencyCategory {
  id: string;
  name: string;
  description: string | null;
  colorTone: string | null;
  competencyCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProficiencyLevel {
  id: string;
  level: number;
  name: string;
  description: string | null;
}

export interface BehaviourIndicator {
  id: string;
  versionId: string;
  type: IndicatorType;
  /** Optional link to a proficiency level; null = applies to the whole competency. */
  proficiencyLevelId: string | null;
  text: string;
  sortOrder: number;
}

export interface CompetencyVersion {
  id: string;
  competencyId: string;
  versionLabel: string;
  status: VersionStatus;
  proficiencyLevels: ProficiencyLevel[];
  indicators: BehaviourIndicator[];
  createdAt: string;
  updatedAt: string;
}

export interface Competency {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string | null;
  /** The currently active version, if any (null while only a draft exists). */
  activeVersion: CompetencyVersion | null;
  /**
   * The most recently created live version. Null only in degenerate cases the
   * serializer genuinely produces — every version soft-deleted, or a row written by
   * an import or script that skipped the version — so callers must guard.
   */
  latestVersion: CompetencyVersion | null;
  versionCount: number;
  isMandatoryAnywhere: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompetencyStats {
  totalCompetencies: number;
  activeCompetencies: number;
  categories: number;
  draftVersions: number;
}

/* ---- Write payloads ---- */

export interface CategoryInput {
  name: string;
  description?: string | null;
  colorTone?: string | null;
}

export interface CompetencyInput {
  categoryId: string;
  name: string;
  description?: string | null;
}

export interface IndicatorInput {
  type: IndicatorType;
  text: string;
  proficiencyLevelId?: string | null;
  sortOrder?: number;
}
