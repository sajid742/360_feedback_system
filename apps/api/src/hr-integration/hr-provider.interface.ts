/**
 * External HR system integration boundary. The 360 app's sync logic depends ONLY
 * on this interface — mirroring the SisProvider pattern. To connect a real HR
 * system (Workday, SuccessFactors, BambooHR, a REST endpoint, …), implement this
 * interface in a new provider and register it in the provider factory. Nothing
 * else in the 360 Feedback System changes; the sync mirrors whatever this returns
 * into the existing internal Employee/Organization model.
 *
 * All records carry a STABLE external id — that is the correlation key used with
 * ExternalIdentityMap; names are never used for matching.
 */

export interface HrOrganization {
  name: string;
}
export interface HrCampus {
  externalId: string;
  name: string;
  /** 'campus' or 'institute' — both map to organization location records. */
  kind?: string;
}
export interface HrDepartment {
  externalId: string;
  name: string;
  parentExternalId?: string | null;
  campusExternalId?: string | null;
  unitType?: string | null;
}
export interface HrDesignation {
  externalId: string;
  name: string;
  level?: number | null;
  promotesToExternalId?: string | null;
}
export interface HrEmployee {
  /** Stable external id (the correlation key stored in ExternalIdentityMap). */
  externalId: string;
  /** Employee code / service number — the reconcile key in the internal model. */
  employeeCode: string;
  fullName: string;
  email: string;
  departmentExternalId?: string | null;
  designationExternalId?: string | null;
  campusExternalId?: string | null;
  /** External id of the line manager (Reporting To). Null/empty = top of hierarchy. */
  managerExternalId?: string | null;
  /** 'active' | 'inactive' | 'terminated' (anything non-active deactivates). */
  status?: string | null;
  joinDate?: string | null;
}

/** A full snapshot of the org from the HR system, ready to reconcile. */
export interface HrSnapshot {
  organization: HrOrganization | null;
  campuses: HrCampus[];
  departments: HrDepartment[];
  designations: HrDesignation[];
  employees: HrEmployee[];
}

export interface HrProvider {
  /** Human-readable provider name for the admin UI. */
  readonly name: string;
  /** Pull the current org snapshot for a tenant. `options` lets a provider vary
   *  behaviour (e.g. the mock scenario) without changing this contract. */
  getSnapshot(organizationId: string, options?: Record<string, unknown>): Promise<HrSnapshot>;
}

/** DI token for the HR provider registry (per-tenant selection). */
export const HR_PROVIDER_REGISTRY = Symbol('HR_PROVIDER_REGISTRY');
