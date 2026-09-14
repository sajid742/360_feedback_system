import { nkey } from './resolver.service';
import type { CampusRow, DepartmentRow, DesignationRow, ImportDataset } from '../org-import.types';

/**
 * Unfold the flat "Staff" sheet — the HR twin of the SIS "Roster" sheet.
 *
 * WHY THIS EXISTS. The Employees sheet already carries `department`, `designation`
 * and `campus`, but the validator requires each of those names to exist either in the
 * system or on its own sheet in the same file:
 *
 *     if (!knownDept(e.department)) push({ severity: 'error', … `Department "…" not found.` })
 *
 * So an HR user with one list of staff — the shape every HR system exports, and the
 * shape a person naturally types — gets a wall of blocking errors unless they also
 * hand-build Departments, Designations and Campuses sheets and keep the spellings in
 * lockstep. That is the same burden the SIS five-sheet template put on schools, and
 * `expandRoster()` is how it was lifted there: the repeated columns in one flat sheet
 * are de-duplicated into the entities behind them.
 *
 * This does the same for HR. It reads the master-data names off the employee rows and
 * synthesises the missing Departments / Designations / Campuses, first-spelling-wins,
 * marked `_derived` so validation can say so out loud and the preview can show them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not touch employees, does not invent a
 * parent department or a seniority level, and never overrides a row the user typed on
 * a real sheet — a name already present on Departments/Designations/Campuses wins,
 * because that row can carry a parent, a level or a campus that this cannot know.
 * Everything downstream — validation, counts, preview, the confirm gate, the upsert on
 * employeeCode, the CSV report — runs unchanged on the result.
 */
export function expandStaff(dataset: ImportDataset): ImportDataset {
  if (dataset.employees.length === 0) return dataset;

  const departments = [...dataset.departments];
  const designations = [...dataset.designations];
  const campuses = [...dataset.campuses];

  // Names the user typed on a real sheet. These are authoritative and are never
  // shadowed by a derived row.
  const haveDept = new Map<string, string>(dataset.departments.map((d) => [nkey(d.name), d.name]));
  const haveDesig = new Map<string, string>(dataset.designations.map((d) => [nkey(d.name), d.name]));
  const haveCampus = new Map<string, string>(dataset.campuses.map((c) => [nkey(c.name), c.name]));

  // Spellings folded onto each derived key, so we can report "Maths"/"maths " rather
  // than silently picking one. Keyed by nkey, value keeps insertion order.
  const variants = new Map<string, Set<string>>();
  const noteVariant = (key: string, spelling: string): void => {
    const set = variants.get(key) ?? new Set<string>();
    set.add(spelling);
    variants.set(key, set);
  };

  for (const e of dataset.employees) {
    const consider = (
      raw: string | undefined,
      have: Map<string, string>,
      make: (name: string, row: number) => void,
    ): void => {
      const name = (raw ?? '').trim();
      if (!name) return;
      const key = nkey(name);
      noteVariant(key, name);
      if (have.has(key)) return;
      have.set(key, name); // first spelling wins, exactly as expandRoster does
      make(name, e._row);
    };

    consider(e.department, haveDept, (name, row) => {
      departments.push({ name, _row: row, _derived: true } as DepartmentRow);
    });
    consider(e.designation, haveDesig, (name, row) => {
      // No level: seniority drives Head-of-Department derivation and guessing it from a
      // job title would be worse than leaving it at the model's own default.
      designations.push({ name, _row: row, _derived: true } as DesignationRow);
    });
    consider(e.campus, haveCampus, (name, row) => {
      campuses.push({ name, _row: row, _derived: true } as CampusRow);
    });
  }

  // Attach the folded spellings to the rows we created, so validation can warn once
  // per record instead of once per row.
  const attach = <T extends { name: string; _derived?: boolean; _variants?: string[] }>(rows: T[]): void => {
    for (const r of rows) {
      if (!r._derived) continue;
      const seen = variants.get(nkey(r.name));
      if (seen && seen.size > 1) r._variants = [...seen];
    }
  };
  attach(departments);
  attach(designations);
  attach(campuses);

  return { ...dataset, departments, designations, campuses };
}
