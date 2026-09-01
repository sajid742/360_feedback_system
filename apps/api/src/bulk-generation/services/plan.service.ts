import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/** One evaluator resolved for an evaluatee, ready to become a reviewer assignment. */
export interface ResolvedEvaluator {
  sourceCode: EvaluatorType;
  reviewerEmployeeId: string;
}

/**
 * `manager` is level 1; deeper levels are `manager_l2`, `manager_l3`, … so the type
 * cannot be a closed union any more. It stays a string, and `managerSourceCode()`
 * is the single place that decides the naming.
 */
export type EvaluatorType = string;

/** The quadrant code for a given rung of the reporting chain. Level 1 keeps the
 *  original `manager` code so every existing cycle, report and mapping is unaffected. */
export function managerSourceCode(level: number): string {
  return level <= 1 ? 'manager' : `manager_l${level}`;
}

/** How many rungs of the chain may be asked. A guard, not a policy — it bounds the
 *  upward walk in an organisation with an accidental reporting loop. */
export const MAX_MANAGER_LEVELS = 6;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface BulkConfig {
  evaluators: { self: boolean; manager: boolean; peer: boolean; subordinate: boolean; parent: boolean };
  /**
   * How many rungs of the reporting line are asked when `evaluators.manager` is on.
   * 1 = the immediate line manager only, which is what every cycle did before this
   * existed and is the default. 3 = immediate manager, their manager, and theirs.
   */
  managerLevels: number;
  peer: { min: number; max: number; crossDepartment: boolean };
  allowOutOfScope: boolean;
  includeParents: boolean;
  channels: string[]; // subset of whatsapp | email | sms | in_app
  notify: boolean;
}

export interface EmployeeLite {
  id: string;
  name: string;
  status: string;
  departmentId: string | null;
  campusId: string | null;
  lineManagerId: string | null;
}

export interface EvaluateePlan {
  employee: EmployeeLite;
  evaluators: ResolvedEvaluator[];
  /** teacherId if this employee is an identity-mapped SIS teacher, else null. */
  teacherId: string | null;
  issues: {
    missingManager: boolean;
    /** Levels 2+ that could not be resolved (short chain, or an inactive rung). */
    missingManagerLevels: number[];
    noPeers: boolean; // fewer than min eligible peers
    noSubordinates: boolean;
  };
}

export interface ScopeResolution {
  scopeType: 'all' | 'campus' | 'department';
  scopeId: string | null;
  scopeName: string;
  /** ids in scope (for department: the unit + all descendants). */
  departmentIds: Set<string> | null;
}

export const DEFAULT_CONFIG: BulkConfig = {
  evaluators: { self: false, manager: true, peer: true, subordinate: true, parent: true },
  managerLevels: 1,
  peer: { min: 1, max: 5, crossDepartment: false },
  allowOutOfScope: false,
  includeParents: true,
  channels: ['in_app', 'email'],
  notify: true,
};

/**
 * Pure planning for a bulk feedback-cycle generation. Resolves the selected scope
 * to eligible (active) employees and computes each evaluatee's evaluators from the
 * EXISTING employee hierarchy (Reporting To / line manager, department, campus).
 * No writes — used identically by preview and generate so the confirmed plan is
 * exactly what gets created.
 */
@Injectable()
export class PlanService {
  constructor(private readonly prisma: PrismaService) {}

  mergeConfig(partial?: DeepPartial<BulkConfig>): BulkConfig {
    return {
      evaluators: { ...DEFAULT_CONFIG.evaluators, ...(partial?.evaluators ?? {}) },
      managerLevels: Math.min(MAX_MANAGER_LEVELS, Math.max(1, Number(partial?.managerLevels ?? DEFAULT_CONFIG.managerLevels) || 1)),
      peer: { ...DEFAULT_CONFIG.peer, ...(partial?.peer ?? {}) },
      allowOutOfScope: partial?.allowOutOfScope ?? DEFAULT_CONFIG.allowOutOfScope,
      includeParents: partial?.includeParents ?? DEFAULT_CONFIG.includeParents,
      channels: partial?.channels?.length ? partial.channels : DEFAULT_CONFIG.channels,
      notify: partial?.notify ?? DEFAULT_CONFIG.notify,
    };
  }

  /** Resolve the scope selection to a name + (for department scope) the descendant unit ids. */
  async resolveScope(orgId: string, scopeType: 'all' | 'campus' | 'department', scopeId?: string | null): Promise<ScopeResolution> {
    if (scopeType === 'all') return { scopeType, scopeId: null, scopeName: 'Entire organization', departmentIds: null };

    if (scopeType === 'campus') {
      if (!scopeId) throw new BadRequestException('Select a campus.');
      const campus = await this.prisma.organization.findFirst({ where: { id: scopeId }, select: { name: true } });
      if (!campus) throw new BadRequestException('Campus not found.');
      return { scopeType, scopeId, scopeName: campus.name, departmentIds: null };
    }

    // department (include all descendant units)
    if (!scopeId) throw new BadRequestException('Select a department.');
    const all = await this.prisma.department.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, parentId: true },
    });
    const root = all.find((d) => d.id === scopeId);
    if (!root) throw new BadRequestException('Department not found.');
    const childrenOf = new Map<string, string[]>();
    for (const d of all) {
      if (!d.parentId) continue;
      childrenOf.set(d.parentId, [...(childrenOf.get(d.parentId) ?? []), d.id]);
    }
    const ids = new Set<string>();
    const walk = (id: string): void => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const c of childrenOf.get(id) ?? []) walk(c);
    };
    walk(scopeId);
    return { scopeType, scopeId, scopeName: root.name, departmentIds: ids };
  }

  private inScope(e: EmployeeLite, scope: ScopeResolution): boolean {
    if (scope.scopeType === 'all') return true;
    if (scope.scopeType === 'campus') return e.campusId === scope.scopeId;
    return e.departmentId != null && scope.departmentIds!.has(e.departmentId);
  }

  /**
   * Build the full plan: for every eligible (in-scope, active) evaluatee, resolve
   * their evaluators per config, apply all safeguards, and record per-evaluatee
   * issues. `teacherId` is filled for identity-mapped teachers so parents can be
   * resolved downstream.
   */
  async buildPlan(orgId: string, scope: ScopeResolution, config: BulkConfig): Promise<EvaluateePlan[]> {
    const rows = await this.prisma.employee.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: {
        id: true, status: true, departmentId: true, campusId: true, lineManagerId: true,
        user: { select: { fullName: true, email: true } },
      },
    });
    const all: EmployeeLite[] = rows.map((r) => ({
      id: r.id,
      name: r.user.fullName ?? r.user.email ?? r.id,
      status: r.status,
      departmentId: r.departmentId,
      campusId: r.campusId,
      lineManagerId: r.lineManagerId,
    }));
    const byId = new Map(all.map((e) => [e.id, e]));
    const activeById = new Map(all.filter((e) => e.status === 'active').map((e) => [e.id, e]));

    // Subordinate + peer indexes keyed by manager, active only.
    const reportsByManager = new Map<string, EmployeeLite[]>();
    for (const e of activeById.values()) {
      if (e.lineManagerId) reportsByManager.set(e.lineManagerId, [...(reportsByManager.get(e.lineManagerId) ?? []), e]);
    }

    // Reverse identity map: employeeId -> SIS teacherId (active teacher mappings).
    const maps = await this.prisma.externalIdentityMap.findMany({
      where: { organizationId: orgId, externalType: 'teacher', active: true },
      select: { externalId: true, employeeId: true },
    });
    const teacherByEmployee = new Map(maps.map((m) => [m.employeeId, m.externalId]));

    const evaluatees = [...activeById.values()].filter((e) => this.inScope(e, scope));

    const usable = (emp: EmployeeLite | undefined): emp is EmployeeLite =>
      !!emp && emp.status === 'active' && (config.allowOutOfScope || this.inScope(emp, scope));

    const plans: EvaluateePlan[] = [];
    for (const E of evaluatees) {
      const evaluators: ResolvedEvaluator[] = [];
      const issues = { missingManager: false, missingManagerLevels: [] as number[], noPeers: false, noSubordinates: false };

      // Self
      if (config.evaluators.self) evaluators.push({ sourceCode: 'self', reviewerEmployeeId: E.id });

      // Managers, one rung at a time up the reporting line.
      //
      // Level 1 is the immediate line manager and behaves exactly as before. Each
      // further level walks one more `lineManagerId` hop. Three things bound it:
      //   - `seen` stops a reporting LOOP from walking forever (the data allows one,
      //     even though the org screens try to prevent it);
      //   - a person already picked at a lower level is not picked again, so a short
      //     chain cannot have one manager counted twice at two different weights;
      //   - the walk stops at the top of the chain rather than padding with blanks.
      if (config.evaluators.manager) {
        const seen = new Set<string>([E.id]);
        let cursor: EmployeeLite | undefined = E;
        for (let level = 1; level <= config.managerLevels; level += 1) {
          const nextId: string | null = cursor?.lineManagerId ?? null;
          const mgr: EmployeeLite | undefined = nextId ? byId.get(nextId) : undefined;
          if (!mgr || seen.has(mgr.id)) {
            // Level 1 missing is the long-standing "no manager" warning. A missing
            // level 2+ is normal near the top of the chart and is reported separately.
            if (level === 1) issues.missingManager = true;
            else issues.missingManagerLevels.push(level);
            break;
          }
          seen.add(mgr.id);
          cursor = mgr;
          if (mgr.status !== 'active') {
            if (level === 1) issues.missingManager = true;
            else issues.missingManagerLevels.push(level);
            continue; // keep climbing: an inactive rung should not hide the one above
          }
          // (a manager excluded only by out-of-scope is not counted as "missing")
          if (usable(mgr)) evaluators.push({ sourceCode: managerSourceCode(level), reviewerEmployeeId: mgr.id });
        }
      }

      // Subordinates (people reporting to E)
      if (config.evaluators.subordinate) {
        const subs = (reportsByManager.get(E.id) ?? []).filter((s) => s.id !== E.id && usable(s));
        if (subs.length === 0) issues.noSubordinates = true;
        for (const s of subs) evaluators.push({ sourceCode: 'subordinate', reviewerEmployeeId: s.id });
      }

      // Peers (same line manager, excluding self)
      if (config.evaluators.peer) {
        let peers = E.lineManagerId
          ? (reportsByManager.get(E.lineManagerId) ?? []).filter((p) => p.id !== E.id && usable(p))
          : [];
        if (!config.peer.crossDepartment) peers = peers.filter((p) => p.departmentId === E.departmentId);
        // Deterministic ordering, then cap at max.
        peers.sort((a, b) => a.id.localeCompare(b.id));
        if (peers.length < Math.max(1, config.peer.min)) issues.noPeers = true;
        for (const p of peers.slice(0, Math.max(0, config.peer.max))) {
          evaluators.push({ sourceCode: 'peer', reviewerEmployeeId: p.id });
        }
      }

      // Guard: never self-evaluate unless Self explicitly enabled.
      const cleaned = evaluators.filter((ev) => ev.sourceCode === 'self' || ev.reviewerEmployeeId !== E.id);

      plans.push({
        employee: E,
        evaluators: cleaned,
        teacherId: config.evaluators.parent && config.includeParents ? teacherByEmployee.get(E.id) ?? null : null,
        issues,
      });
    }
    return plans;
  }
}
