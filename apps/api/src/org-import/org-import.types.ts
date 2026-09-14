/** Shared types for the Organization Data Import & Onboarding utility. */

/** The entities this utility can import. SIS/students/parents/teachers are OUT of scope. */
export type ImportEntity =
  | 'organization'
  | 'campuses'
  | 'departments'
  | 'designations'
  | 'employees'
  | 'competencies';

/** Import execution mode (data-cleaning strategy) chosen at Confirm. */
export type ImportMode =
  | 'skip' // insert new, skip existing (skip duplicates)
  | 'update' // insert new + update existing (upsert)
  | 'replace' // wipe existing org structural data, then insert (destructive)
  | 'reset'; // wipe existing org structural data only, import nothing (destructive)

/**
 * Set on a master-data row that the flat Staff sheet DERIVED from an employee row
 * rather than the user typing it on its own sheet. Carried through the stored job so
 * validation can warn "this department will be created", and so the preview shows
 * exactly what the one-sheet file implies. `_variants` lists other spellings in the
 * file that folded onto the same record.
 */
export interface DerivedMeta { _derived?: boolean; _variants?: string[] }

export interface OrganizationRow { name?: string; slug?: string; status?: string }
export interface CampusRow extends DerivedMeta { name: string; slug?: string; status?: string; _row: number }
export interface DepartmentRow extends DerivedMeta { name: string; parent?: string; campus?: string; unitType?: string; _row: number }
export interface DesignationRow extends DerivedMeta { name: string; level?: number; promotesTo?: string; _row: number }
export interface EmployeeRow {
  employeeCode: string; fullName?: string; email?: string;
  department?: string; designation?: string; campus?: string;
  managerCode?: string; joinDate?: string; status?: string; password?: string; _row: number;
}
export interface CompetencyRow { category: string; name: string; description?: string; _row: number }

/** Normalized, parsed dataset — the canonical form the rest of the pipeline works on. */
export interface ImportDataset {
  organization: OrganizationRow | null;
  campuses: CampusRow[];
  departments: DepartmentRow[];
  designations: DesignationRow[];
  employees: EmployeeRow[];
  competencies: CompetencyRow[];
}

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  entity: ImportEntity;
  row: number | null; // 1-based source row (null = whole-entity/relationship issue)
  field: string | null;
  key: string | null; // the record's business key (code/name) when known
  severity: Severity;
  message: string;
}

export interface EntityCounts {
  entity: ImportEntity;
  parsed: number;
  toCreate: number;
  toUpdate: number;
  toSkip: number;
}

export interface ValidationResult {
  counts: EntityCounts[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Small per-entity sample for the preview table. */
  preview: Record<string, Record<string, unknown>[]>;
  canImport: boolean; // false when there are blocking errors
}

export interface EntitySummary {
  entity: ImportEntity;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface ImportSummary {
  perEntity: EntitySummary[];
  warnings: ValidationIssue[];
  failures: ValidationIssue[];
  mode: ImportMode;
}
