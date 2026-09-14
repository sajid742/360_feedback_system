import { Injectable } from '@nestjs/common';
import { nkey, type ExistingData } from './resolver.service';
import type { EntityCounts, ImportDataset, ImportEntity, ImportMode, ValidationIssue, ValidationResult } from '../org-import.types';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Maximum employee rows per file. Must match the guard in ImportService.run(). */
export const MAX_EMPLOYEE_ROWS = 5000;
const INACTIVE = new Set(['inactive', 'terminated', 'disabled', 'left', 'resigned']);

/** Structural + referential validation for a parsed import dataset. Read-only. */
@Injectable()
export class ValidationService {
  /** Full validation result for a given mode (counts depend on mode; issues don't). */
  build(dataset: ImportDataset, existing: ExistingData, mode: ImportMode): ValidationResult {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    const push = (i: ValidationIssue) => (i.severity === 'error' ? errors : warnings).push(i);

    // The row cap was only enforced at Confirm, so an admin could upload 6,000 rows,
    // see a clean preview, click Import and only then be told the file was too big
    // (F10). Surface it during validation, where every other blocking problem appears.
    if (dataset.employees.length > MAX_EMPLOYEE_ROWS) {
      push({
        severity: 'error',
        entity: 'employees',
        row: null,
        field: null,
        key: null,
        message: `This file has ${dataset.employees.length} employee rows; the limit is ${MAX_EMPLOYEE_ROWS} per file. Split it into smaller files and import them one after another.`,
      });
    }

    // File-level key sets (resolve references against file OR existing DB).
    const campusKeys = new Set(dataset.campuses.map((c) => nkey(c.name)));
    const deptKeys = new Set(dataset.departments.map((d) => nkey(d.name)));
    const desigKeys = new Set(dataset.designations.map((d) => nkey(d.name)));
    const empCodes = new Set(dataset.employees.map((e) => e.employeeCode.trim()));
    const knownCampus = (n?: string) => !n || campusKeys.has(nkey(n)) || existing.campusesByName.has(nkey(n));
    const knownDept = (n?: string) => !n || deptKeys.has(nkey(n)) || existing.departmentsByName.has(nkey(n));
    const knownDesig = (n?: string) => !n || desigKeys.has(nkey(n)) || existing.designationsByName.has(nkey(n));
    const knownEmp = (c?: string) => !c || empCodes.has(c.trim()) || existing.employeesByCode.has(c.trim());

    // Master data the flat Staff sheet derived from the employee rows. Say so — an
    // administrator should never discover after the fact that a typo in a Department
    // cell quietly created a new department. Warnings, not errors: creating them is the
    // point of the flat sheet.
    for (const [entity, rows] of [
      ['departments', dataset.departments],
      ['designations', dataset.designations],
      ['campuses', dataset.campuses],
    ] as const) {
      for (const r of rows) {
        if (!r._derived) continue;
        const label = entity === 'departments' ? 'Department' : entity === 'designations' ? 'Designation' : 'Campus/Institute';
        const known =
          entity === 'departments' ? existing.departmentsByName.has(nkey(r.name))
            : entity === 'designations' ? existing.designationsByName.has(nkey(r.name))
              : existing.campusesByName.has(nkey(r.name));
        if (!known) {
          push({
            entity, row: r._row, field: 'name', key: r.name, severity: 'warning',
            message: `${label} "${r.name}" does not exist yet and will be created from the staff list (first seen at row ${r._row}). Check the spelling if that is not what you meant.`,
          });
        }
        if (r._variants && r._variants.length > 1) {
          push({
            entity, row: r._row, field: 'name', key: r.name, severity: 'warning',
            message: `${label} "${r.name}" was also written as ${r._variants.filter((v) => v !== r.name).map((v) => `"${v}"`).join(', ')}. These differ only in case or spacing, so they are treated as one record named "${r.name}".`,
          });
        }
      }
    }

    this.checkDupes(dataset.campuses, (r) => nkey(r.name), 'campuses', 'name', push);
    this.checkDupes(dataset.departments, (r) => nkey(r.name), 'departments', 'name', push);
    this.checkDupes(dataset.designations, (r) => nkey(r.name), 'designations', 'name', push);
    this.checkDupes(dataset.competencies, (r) => nkey(r.name), 'competencies', 'name', push);
    /*
     * Employees were the one entity NOT checked for duplicates, and they are the one
     * where a duplicate does silent damage. Two rows carrying the same employee code do
     * not create two people — the second is treated as an update of the first — so the
     * earlier row's name, department and manager are overwritten by the later row and
     * nothing anywhere says so. On a hand-built staff list, two rows for one person is
     * a mistake far more often than it is an intention.
     */
    this.checkDupes(dataset.employees, (r) => r.employeeCode.trim(), 'employees', 'employeeCode', push);

    // Campuses — name required (guaranteed by parse); nothing else to validate.

    // Departments — references + circular parent.
    for (const d of dataset.departments) {
      if (d.parent && !knownDept(d.parent)) push({ entity: 'departments', row: d._row, field: 'parent', key: d.name, severity: 'error', message: `Parent department "${d.parent}" not found in the file or the system.` });
      if (d.campus && !knownCampus(d.campus)) push({ entity: 'departments', row: d._row, field: 'campus', key: d.name, severity: 'error', message: `Campus/Institute "${d.campus}" not found in the file or the system.` });
    }
    this.detectCycles(
      dataset.departments.map((d) => ({ key: nkey(d.name), parent: d.parent ? nkey(d.parent) : null, row: d._row, label: d.name })),
      this.existingParentEdges(existing.departmentsByName),
      'departments', 'parent', push,
    );

    // Designations — promotion reference + circular promotion path.
    for (const d of dataset.designations) {
      if (d.promotesTo && !knownDesig(d.promotesTo)) push({ entity: 'designations', row: d._row, field: 'promotesTo', key: d.name, severity: 'error', message: `Promotion target "${d.promotesTo}" not found.` });
    }
    this.detectCycles(
      dataset.designations.map((d) => ({ key: nkey(d.name), parent: d.promotesTo ? nkey(d.promotesTo) : null, row: d._row, label: d.name })),
      new Map(), 'designations', 'promotesTo', push,
    );

    // Employees — required fields, email uniqueness, references, manager, circular.
    for (const e of dataset.employees) {
      if (!e.fullName) push({ entity: 'employees', row: e._row, field: 'fullName', key: e.employeeCode, severity: 'error', message: 'Full name is required.' });
      if (!e.email) push({ entity: 'employees', row: e._row, field: 'email', key: e.employeeCode, severity: 'error', message: 'Email is required.' });
      else if (!EMAIL_RE.test(e.email)) push({ entity: 'employees', row: e._row, field: 'email', key: e.employeeCode, severity: 'warning', message: `Email "${e.email}" does not look valid.` });
      else {
        const owner = existing.emailsInUse.get(e.email.toLowerCase());
        const self = existing.employeesByCode.get(e.employeeCode.trim());
        if (owner && !(self && self.userId === owner)) push({ entity: 'employees', row: e._row, field: 'email', key: e.employeeCode, severity: 'error', message: `Email "${e.email}" is already used by another user.` });
      }
      if (!knownDept(e.department)) push({ entity: 'employees', row: e._row, field: 'department', key: e.employeeCode, severity: 'error', message: `Department "${e.department}" not found.` });
      if (!knownDesig(e.designation)) push({ entity: 'employees', row: e._row, field: 'designation', key: e.employeeCode, severity: 'error', message: `Designation "${e.designation}" not found.` });
      if (!knownCampus(e.campus)) push({ entity: 'employees', row: e._row, field: 'campus', key: e.employeeCode, severity: 'error', message: `Campus/Institute "${e.campus}" not found.` });
      if (!e.managerCode) push({ entity: 'employees', row: e._row, field: 'managerCode', key: e.employeeCode, severity: 'warning', message: 'No manager (treated as a top-level employee).' });
      else if (e.managerCode.trim() === e.employeeCode.trim()) push({ entity: 'employees', row: e._row, field: 'managerCode', key: e.employeeCode, severity: 'error', message: 'An employee cannot report to themselves.' });
      else if (!knownEmp(e.managerCode)) push({ entity: 'employees', row: e._row, field: 'managerCode', key: e.employeeCode, severity: 'error', message: `Manager code "${e.managerCode}" not found in the file or the system.` });
      if (e.status && INACTIVE.has(nkey(e.status))) push({ entity: 'employees', row: e._row, field: 'status', key: e.employeeCode, severity: 'warning', message: `Employee is ${e.status} (inactive employees are imported but excluded from evaluations).` });
    }
    this.detectCycles(
      dataset.employees.map((e) => ({ key: e.employeeCode.trim(), parent: e.managerCode ? e.managerCode.trim() : null, row: e._row, label: e.employeeCode })),
      this.existingManagerEdges(existing.employeesByCode),
      'employees', 'managerCode', push, false,
    );

    const counts = this.counts(dataset, existing, mode);
    const preview = this.preview(dataset);
    return { counts, errors, warnings, preview, canImport: errors.length === 0 };
  }

  private checkDupes<T extends { _row: number }>(rows: T[], keyOf: (r: T) => string, entity: ImportEntity, field: string, push: (i: ValidationIssue) => void): void {
    const seen = new Map<string, number>();
    for (const r of rows) {
      const k = keyOf(r);
      if (!k) continue;
      if (seen.has(k)) push({ entity, row: r._row, field, key: k, severity: 'error', message: `Duplicate ${field} "${k}" (first seen at row ${seen.get(k)}). Keys must be unique.` });
      else seen.set(k, r._row);
    }
  }

  private existingParentEdges(byName: Map<string, { id: string; name: string; parentId: string | null }>): Map<string, string | null> {
    const idToName = new Map<string, string>();
    for (const v of byName.values()) idToName.set(v.id, nkey(v.name));
    const edges = new Map<string, string | null>();
    for (const v of byName.values()) edges.set(nkey(v.name), v.parentId ? idToName.get(v.parentId) ?? null : null);
    return edges;
  }

  private existingManagerEdges(byCode: Map<string, { id: string; employeeCode: string; lineManagerId: string | null }>): Map<string, string | null> {
    const idToCode = new Map<string, string>();
    for (const v of byCode.values()) idToCode.set(v.id, v.employeeCode.trim());
    const edges = new Map<string, string | null>();
    for (const v of byCode.values()) edges.set(v.employeeCode.trim(), v.lineManagerId ? idToCode.get(v.lineManagerId) ?? null : null);
    return edges;
  }

  /**
   * Detect circular references. File edges override existing edges; nodes not in
   * the file fall back to the existing graph so a file row pointing into the DB is
   * still checked. Reports one error per node that sits on a cycle.
   */
  private detectCycles(
    fileNodes: { key: string; parent: string | null; row: number; label: string }[],
    existingEdges: Map<string, string | null>,
    entity: ImportEntity, field: string, push: (i: ValidationIssue) => void, keysAreRaw = true,
  ): void {
    const edges = new Map<string, string | null>(existingEdges);
    const rowOf = new Map<string, number>();
    const labelOf = new Map<string, string>();
    for (const n of fileNodes) { edges.set(n.key, n.parent); rowOf.set(n.key, n.row); labelOf.set(n.key, n.label); }
    const norm = (k: string | null) => (k == null ? null : keysAreRaw ? k.trim() : k);
    for (const start of fileNodes.map((n) => n.key)) {
      const seen = new Set<string>();
      let cur: string | null = start;
      while (cur != null) {
        if (seen.has(cur)) {
          push({ entity, row: rowOf.get(start) ?? null, field, key: labelOf.get(start) ?? start, severity: 'error', message: `Circular ${field} chain detected involving "${labelOf.get(start) ?? start}".` });
          break;
        }
        seen.add(cur);
        cur = edges.has(cur) ? norm(edges.get(cur) ?? null) : null;
      }
    }
  }

  /** Per-entity create/update/skip counts for the chosen mode. */
  private counts(dataset: ImportDataset, existing: ExistingData, mode: ImportMode): EntityCounts[] {
    const wipe = mode === 'replace' || mode === 'reset';
    const build = (entity: ImportEntity, keys: string[], existsFn: (k: string) => boolean): EntityCounts => {
      const parsed = keys.length;
      if (mode === 'reset') return { entity, parsed, toCreate: 0, toUpdate: 0, toSkip: parsed };
      if (wipe) return { entity, parsed, toCreate: parsed, toUpdate: 0, toSkip: 0 };
      let create = 0, update = 0, skip = 0;
      for (const k of keys) {
        const ex = existsFn(k);
        if (!ex) create++;
        else if (mode === 'update') update++;
        else skip++;
      }
      return { entity, parsed, toCreate: create, toUpdate: update, toSkip: skip };
    };
    return [
      build('campuses', dataset.campuses.map((c) => nkey(c.name)), (k) => existing.campusesByName.has(k)),
      build('departments', dataset.departments.map((d) => nkey(d.name)), (k) => existing.departmentsByName.has(k)),
      build('designations', dataset.designations.map((d) => nkey(d.name)), (k) => existing.designationsByName.has(k)),
      build('employees', dataset.employees.map((e) => e.employeeCode.trim()), (k) => existing.employeesByCode.has(k)),
      // Competencies: existing ones are always skipped (versioned content isn't overwritten by import).
      { entity: 'competencies', parsed: dataset.competencies.length, ...this.competencyCounts(dataset, existing, mode) },
    ];
  }

  private competencyCounts(dataset: ImportDataset, existing: ExistingData, mode: ImportMode): { toCreate: number; toUpdate: number; toSkip: number } {
    if (mode === 'reset') return { toCreate: 0, toUpdate: 0, toSkip: dataset.competencies.length };
    if (mode === 'replace') return { toCreate: dataset.competencies.length, toUpdate: 0, toSkip: 0 };
    let create = 0, skip = 0;
    for (const c of dataset.competencies) (existing.competenciesByName.has(nkey(c.name)) ? skip++ : create++);
    return { toCreate: create, toUpdate: 0, toSkip: skip };
  }

  private preview(dataset: ImportDataset): Record<string, Record<string, unknown>[]> {
    const take = <T>(rows: T[], n = 5) => rows.slice(0, n);
    return {
      organization: dataset.organization ? [dataset.organization as Record<string, unknown>] : [],
      campuses: take(dataset.campuses).map((c) => ({ name: c.name, slug: c.slug ?? '(auto)', status: c.status ?? 'active' })),
      departments: take(dataset.departments).map((d) => ({ name: d.name, parent: d.parent ?? '—', campus: d.campus ?? '—', unitType: d.unitType ?? 'department' })),
      designations: take(dataset.designations).map((d) => ({ name: d.name, level: d.level ?? 0, promotesTo: d.promotesTo ?? '—' })),
      employees: take(dataset.employees).map((e) => ({ employeeCode: e.employeeCode, fullName: e.fullName ?? '', email: e.email ?? '', department: e.department ?? '—', designation: e.designation ?? '—', manager: e.managerCode ?? '—', status: e.status ?? 'active' })),
      competencies: take(dataset.competencies).map((c) => ({ category: c.category, name: c.name })),
    };
  }
}
