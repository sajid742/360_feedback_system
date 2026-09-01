import { useCallback, useEffect, useState } from 'react';
import { FileText, Pencil, Plus, Search, UserX } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api-client';
import { orgApi, type Campus, type DepartmentNode, type Designation, type Employee } from '../api';

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  active: 'success',
  on_leave: 'warning',
  terminated: 'danger',
};

export function EmployeesPanel(): JSX.Element {
  const [search, setSearch] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [designations, setDesignations] = useState<Designation[]>([]);
  // Placement reference data. Departments and campuses come from the same endpoints the
  // Departments and Campuses tabs use; `managers` is an unfiltered employee list so the
  // Reporting-to picker does not shrink as you type in the search box.
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [managers, setManagers] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    orgApi
      .listEmployees(search)
      .then((r) => setEmployees(r.items))
      .finally(() => setLoading(false));
  }, [search]);

  const reloadReference = useCallback(() => {
    orgApi.listDesignations().then(setDesignations).catch(() => undefined);
    orgApi.deptTree().then(setDepartments).catch(() => undefined);
    orgApi.listCampuses().then(setCampuses).catch(() => undefined);
    orgApi.listEmployees('').then((r) => setManagers(r.items)).catch(() => undefined);
  }, []);

  useEffect(() => reload(), [reload]);
  useEffect(() => reloadReference(), [reloadReference]);

  async function terminate(employee: Employee): Promise<void> {
    await orgApi.terminate(employee.id);
    reload();
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employees" className="pl-9" />
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus /> Add employee
        </Button>
      </div>

      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Code</th>
                <th className="p-3">Designation</th>
                <th className="p-3">Department</th>
                <th className="p-3">Manager</th>
                <th className="p-3">Status</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="p-3">
                    <div className="font-medium">{e.user.fullName ?? e.user.email}</div>
                    <div className="text-xs text-muted-foreground">{e.user.email}</div>
                  </td>
                  <td className="p-3">{e.employeeCode}</td>
                  <td className="p-3">{e.designation?.name ?? '—'}</td>
                  <td className="p-3">
                    {e.department?.name ?? <span className="text-muted-foreground">Unassigned</span>}
                  </td>
                  <td className="p-3">{e.lineManager?.name ?? '—'}</td>
                  <td className="p-3">
                    <Badge variant={STATUS_VARIANT[e.status] ?? 'neutral'}>{e.status}</Badge>
                  </td>
                  <td className="p-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => window.open(`/reports/individual/${e.id}`, '_blank')}>
                      <FileText /> 360 Report
                    </Button>
                    {e.status !== 'terminated' ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(e)}>
                          <Pencil /> Edit
                        </Button>
                        <Button variant="ghost" size="sm" className="text-red-600" onClick={() => terminate(e)}>
                          <UserX /> Terminate
                        </Button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
              {employees.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">
                    No employees found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      <CreateEmployeeDialog
        open={open}
        designations={designations}
        departments={departments}
        campuses={campuses}
        managers={managers}
        onOpenChange={setOpen}
        onSaved={() => { reload(); reloadReference(); }}
      />
      <EditEmployeeDialog
        employee={editing}
        designations={designations}
        departments={departments}
        campuses={campuses}
        managers={managers}
        onOpenChange={(next) => { if (!next) setEditing(null); }}
        onSaved={() => { reload(); reloadReference(); }}
      />
    </div>
  );
}

/**
 * `/organization/departments/tree` returns a NESTED tree; a flat `.map` over it would
 * offer only the root unit. Flattened depth-first with indentation so the picker shows
 * all 23 units and still reads as a hierarchy.
 */
function flattenDepartments(nodes: DepartmentNode[], depth = 0): { node: DepartmentNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenDepartments(node.children, depth + 1)]);
}

const EMPTY_FORM = {
  email: '',
  fullName: '',
  employeeCode: '',
  designationId: '',
  departmentId: '',
  campusId: '',
  lineManagerId: '',
  joinDate: '',
};

/** Everything that places a person in the organisation, shared by create and edit. */
interface PlacementRefs {
  designations: Designation[];
  departments: DepartmentNode[];
  campuses: Campus[];
  managers: Employee[];
}

interface CreateProps extends PlacementRefs {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/**
 * The four placement fields.
 *
 * These were accepted by the API from the start but never collected here, so an
 * employee added through the UI landed with no department and no manager: invisible on
 * the org chart, "Unassigned" in every departmental report, outside every manager's data
 * scope, and — because peers are derived from a shared line manager — skipped by bulk
 * generation. Kept in one component so the create and edit dialogs cannot drift apart.
 */
function PlacementFields({
  value,
  onChange,
  refs,
  idPrefix,
  excludeManagerId,
}: {
  value: { departmentId: string; designationId: string; campusId: string; lineManagerId: string };
  onChange: (patch: Partial<{ departmentId: string; designationId: string; campusId: string; lineManagerId: string }>) => void;
  refs: PlacementRefs;
  idPrefix: string;
  /** Someone cannot report to themselves; the server rejects it, the picker shouldn't offer it. */
  excludeManagerId?: string;
}): JSX.Element {
  const select = 'h-10 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-designation`}>Designation</Label>
        <select
          id={`${idPrefix}-designation`}
          value={value.designationId}
          onChange={(e) => onChange({ designationId: e.target.value })}
          className={select}
        >
          <option value="">— None —</option>
          {refs.designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-department`}>Department / unit</Label>
        <select
          id={`${idPrefix}-department`}
          value={value.departmentId}
          onChange={(e) => onChange({ departmentId: e.target.value })}
          className={select}
        >
          <option value="">— Unassigned —</option>
          {flattenDepartments(refs.departments).map(({ node, depth }) => (
            <option key={node.id} value={node.id}>
              {`${'\u00a0\u00a0'.repeat(depth)}${node.name}`}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Departmental and campus reports group by this. Leaving it empty shows the person as Unassigned.
        </p>
      </div>
      {refs.campuses.length > 0 ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-campus`}>Campus</Label>
          <select
            id={`${idPrefix}-campus`}
            value={value.campusId}
            onChange={(e) => onChange({ campusId: e.target.value })}
            className={select}
          >
            <option value="">— Follow the department —</option>
            {refs.campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-manager`}>Reporting to</Label>
        <select
          id={`${idPrefix}-manager`}
          value={value.lineManagerId}
          onChange={(e) => onChange({ lineManagerId: e.target.value })}
          className={select}
        >
          <option value="">— No manager —</option>
          {refs.managers
            .filter((m) => m.id !== excludeManagerId && m.status !== 'terminated')
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.user.fullName ?? m.user.email}
                {m.designation?.name ? ` · ${m.designation.name}` : ''}
              </option>
            ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Sets the org chart, the manager&rsquo;s data scope, and who is picked as manager, peer and
          subordinate when feedback cycles are generated.
        </p>
      </div>
    </>
  );
}

function CreateEmployeeDialog({ open, designations, departments, campuses, managers, onOpenChange, onSaved }: CreateProps): JSX.Element {
  const [form, setForm] = useState(EMPTY_FORM);
  const [sendInvite, setSendInvite] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // How the new person gets in. Previously the API returned a temporary password and
  // this dialog threw it away, so a UI-created employee had no way to sign in and the
  // admin had nothing to hand over (F28).
  const [handover, setHandover] = useState<{ name: string; email: string; temporaryPassword: string | null; invitation?: { sent: boolean; reason?: string } } | null>(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setSendInvite(true);
      setError(null);
      setHandover(null);
    }
  }, [open]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await orgApi.createEmployee({
        email: form.email,
        fullName: form.fullName,
        employeeCode: form.employeeCode,
        designationId: form.designationId || undefined,
        departmentId: form.departmentId || undefined,
        campusId: form.campusId || undefined,
        lineManagerId: form.lineManagerId || undefined,
        joinDate: form.joinDate || undefined,
        sendInvite,
      });
      onSaved();
      setHandover({
        name: form.fullName,
        email: form.email,
        temporaryPassword: created.temporaryPassword ?? null,
        invitation: created.invitation,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create employee.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {handover ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{handover.name} added</DialogTitle>
            </DialogHeader>
            {handover.invitation?.sent ? (
              <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
                An invitation was emailed to <span className="font-medium">{handover.email}</span>. They choose their own
                password from that link — nothing further to hand over.
              </p>
            ) : (
              <div className="grid gap-2">
                {handover.invitation && !handover.invitation.sent ? (
                  <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                    The invitation could not be emailed{handover.invitation.reason ? ` (${handover.invitation.reason})` : ''}. Give
                    them the temporary password below instead — they will be asked to change it at first sign-in.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Give them this temporary password. It is shown once and they must change it at first sign-in.
                  </p>
                )}
                {handover.temporaryPassword ? (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2">
                    <code className="text-sm font-semibold">{handover.temporaryPassword}</code>
                    <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(handover.temporaryPassword ?? '')}>Copy</Button>
                  </div>
                ) : null}
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add employee</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="fullName">Full name</Label>
            <Input id="fullName" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="code">Employee code</Label>
            <Input id="code" value={form.employeeCode} onChange={(e) => setForm((f) => ({ ...f, employeeCode: e.target.value }))} />
          </div>
          <PlacementFields
            value={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            refs={{ designations, departments, campuses, managers }}
            idPrefix="create"
          />
          <div className="grid gap-2">
            <Label htmlFor="create-joinDate">Join date</Label>
            <Input
              id="create-joinDate"
              type="date"
              value={form.joinDate}
              onChange={(e) => setForm((f) => ({ ...f, joinDate: e.target.value }))}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} className="mt-1" />
            <span>
              Email an invitation
              <span className="block text-xs text-muted-foreground">
                They get a link to choose their own password, so you never have to pass one on. If email isn’t
                configured, a temporary password is shown here instead.
              </span>
            </span>
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface EditProps extends PlacementRefs {
  employee: Employee | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/**
 * Change where an existing person sits: department, designation, campus, reporting line
 * and working status.
 *
 * `PUT /organization/employees/:id` and `orgApi.updateEmployee` both already existed —
 * nothing in the UI had ever called them, so a placement mistake could only be corrected
 * by re-importing the employee sheet or editing the database. Name, email and employee
 * code are deliberately not editable here: they are identity, and the import and HR sync
 * paths own them.
 */
function EditEmployeeDialog({ employee, designations, departments, campuses, managers, onOpenChange, onSaved }: EditProps): JSX.Element {
  const [form, setForm] = useState({ designationId: '', departmentId: '', campusId: '', lineManagerId: '' });
  const [status, setStatus] = useState('active');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!employee) return;
    setForm({
      designationId: employee.designation?.id ?? '',
      departmentId: employee.department?.id ?? '',
      campusId: employee.campusId ?? '',
      lineManagerId: employee.lineManagerId ?? '',
    });
    setStatus(employee.status === 'on_leave' ? 'on_leave' : 'active');
    setError(null);
  }, [employee]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!employee) return;
    setSaving(true);
    setError(null);
    try {
      // Empty string means "clear it" — sent as null, not undefined. The server reads
      // undefined as "leave as it was", so sending undefined would make a placement
      // one-way: assignable but never removable.
      await orgApi.updateEmployee(employee.id, {
        designationId: form.designationId || null,
        departmentId: form.departmentId || null,
        campusId: form.campusId || null,
        lineManagerId: form.lineManagerId || null,
        status,
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      // The server refuses a reporting loop and blocks edits while the tenant is in
      // external-HR mode; both arrive as a readable message worth showing verbatim.
      setError(err instanceof ApiError ? err.message : 'Could not update this employee.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(employee)} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{employee?.user.fullName ?? employee?.user.email ?? 'Employee'}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {employee?.employeeCode ? `Code ${employee.employeeCode} · ` : ''}
            {employee?.user.email}
          </p>

          <PlacementFields
            value={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            refs={{ designations, departments, campuses, managers }}
            idPrefix="edit"
            excludeManagerId={employee?.id}
          />

          <div className="grid gap-2">
            <Label htmlFor="edit-status">Status</Label>
            <select
              id="edit-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-10 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="active">Active</option>
              <option value="on_leave">On leave</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Use Terminate on the employee row to end employment; it is not a status change.
            </p>
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
