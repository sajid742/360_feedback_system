import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Check, KeyRound, Loader2, Mail, Search, ShieldCheck, UserCog, X } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { rbacApi, type Matrix, type RbacRole, type RbacUser, type RbacUserDetail } from './api';

const SCOPE_LABEL: Record<string, string> = { organization: 'Organization', reporting: 'Reporting hierarchy', own: 'Own data' };
const ROLE_VARIANT: Record<string, BadgeVariant> = { 'Super Admin': 'danger', 'HR/Admin': 'brand', Manager: 'info', Employee: 'neutral', Viewer: 'warning' };

export function AccessControlPage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><ShieldCheck className="size-4" /></span>
          <h1 className="text-2xl font-extrabold tracking-tight">Access Control</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign predefined roles to users and review what each role can do. Authorization is enforced on the server — roles here control real access.
        </p>
      </div>
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles &amp; Permissions</TabsTrigger>
        </TabsList>
        <TabsContent value="users"><UsersTab /></TabsContent>
        <TabsContent value="roles"><RolesTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------- Users ------------------------------- */
const PAGE_SIZE = 50;

function UsersTab(): JSX.Element {
  const [roles, setRoles] = useState<RbacRole[]>([]);
  const [users, setUsers] = useState<RbacUser[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState<RbacUser | null>(null);
  const [detail, setDetail] = useState<RbacUser | null>(null);
  const [resetting, setResetting] = useState<RbacUser | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    // F-P7: ask for one page instead of the whole org's user list.
    rbacApi
      .users({ search: search || undefined, roleId: roleFilter || undefined, status: statusFilter || undefined, page, pageSize: PAGE_SIZE })
      .then((r) => { setUsers(r.items); setTotal(r.total); setTotalPages(r.totalPages); })
      .catch(() => { setUsers([]); setTotal(0); setTotalPages(1); });
  }, [search, roleFilter, statusFilter, page]);

  // Any filter change restarts at page 1 so the user never lands on an empty page.
  useEffect(() => { setPage(1); }, [search, roleFilter, statusFilter]);

  useEffect(() => { rbacApi.roles().then(setRoles).catch(() => setRoles([])); }, []);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  /**
   * Email a set-password link instead of handing over a credential (F28). Useful for
   * people onboarded before invitations existed, or whose invitation expired.
   */
  async function invite(u: RbacUser) {
    setBusy(`invite:${u.id}`); setError(null);
    try {
      const r = await rbacApi.invite(u.id);
      if (r.sent) toast.success(`Invitation emailed to ${r.email}.`);
      else toast.error(r.reason ?? 'The invitation could not be emailed.');
    } catch (e) { const m = e instanceof ApiError ? e.message : 'Failed.'; setError(m); toast.error(m); }
    finally { setBusy(null); }
  }

  async function toggleActive(u: RbacUser) {
    setBusy(u.id); setError(null);
    try {
      await rbacApi.setActive(u.id, u.status !== 'active'); load();
      toast.success(`${u.name} ${u.status === 'active' ? 'deactivated' : 'activated'}.`);
    }
    catch (e) { const m = e instanceof ApiError ? e.message : 'Failed.'; setError(m); toast.error(m); }
    finally { setBusy(null); }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" className="h-9 w-56 pl-8" />
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
          <option value="">All roles</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <span className="ml-auto text-xs text-muted-foreground">{users ? `${total} user${total === 1 ? '' : 's'}` : ''}</span>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <Card className="overflow-hidden">
        {!users ? <div className="p-6"><Skeleton className="h-40 w-full" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
              <tr><th className="p-3">User</th><th className="p-3">Employee</th><th className="p-3">Roles</th><th className="p-3">Status</th><th className="p-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-3"><button className="text-left" onClick={() => setDetail(u)}><span className="font-medium">{u.name}</span><span className="block text-xs text-muted-foreground">{u.email}</span></button></td>
                  <td className="p-3 text-xs text-muted-foreground">{u.employeeCode ? `${u.employeeCode}${u.department ? ` · ${u.department}` : ''}` : '—'}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 ? <span className="text-xs text-muted-foreground">No role</span> : u.roles.map((r) => <Badge key={r.id} variant={ROLE_VARIANT[r.name] ?? 'neutral'}>{r.name}</Badge>)}
                    </div>
                  </td>
                  <td className="p-3"><Badge variant={u.status === 'active' ? 'success' : 'neutral'}>{u.status}</Badge></td>
                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditing(u)}><UserCog /> Roles</Button>
                      <Button size="sm" variant="outline" onClick={() => setResetting(u)}><KeyRound /> Reset password</Button>
                      <Button size="sm" variant="outline" disabled={busy === `invite:${u.id}`} onClick={() => invite(u)}><Mail /> Invite</Button>
                      <Button size="sm" variant="outline" disabled={busy === u.id} onClick={() => toggleActive(u)}>{u.status === 'active' ? 'Deactivate' : 'Activate'}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {users && totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
          </div>
        </div>
      ) : null}

      {editing ? <RoleEditor user={editing} roles={roles} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /> : null}
      {detail ? <UserDetailDrawer user={detail} onClose={() => setDetail(null)} /> : null}
      {resetting ? <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} /> : null}
    </div>
  );
}

/** Admin password reset: set/generate a temporary password + optional force-change. */
function ResetPasswordModal({ user, onClose }: { user: RbacUser; onClose: () => void }): JSX.Element {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [requireChange, setRequireChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ temporaryPassword: string; requireChange: boolean } | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const body = mode === 'manual' ? { temporaryPassword, requireChange } : { requireChange };
      const res = await rbacApi.resetPassword(user.id, body);
      setResult({ temporaryPassword: res.temporaryPassword, requireChange: res.requireChange });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to reset password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">Reset password</h3>
        <p className="mb-3 text-xs text-muted-foreground">{user.name} · {user.email}</p>

        {result ? (
          <div className="grid gap-3">
            <p className="text-sm">Share this temporary password with the user through a secure channel. It is shown only once.</p>
            <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 p-3">
              <code className="text-sm font-semibold">{result.temporaryPassword}</code>
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(result.temporaryPassword)}>Copy</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {result.requireChange
                ? 'The user must set a new password the next time they sign in. Their current sessions have been signed out.'
                : 'The user can sign in with this password and keep using it. Their current sessions have been signed out.'}
            </p>
            <div className="mt-1 flex justify-end"><Button onClick={onClose}>Done</Button></div>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} /> Generate a strong temporary password
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} /> Set a temporary password myself
              </label>
              {mode === 'manual' ? (
                <Input type="text" value={temporaryPassword} onChange={(e) => setTemporaryPassword(e.target.value)} placeholder="Temporary password (must meet the password policy)" className="mt-1" />
              ) : null}
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-sm">
              <input type="checkbox" checked={requireChange} onChange={(e) => setRequireChange(e.target.checked)} />
              Require the user to change it at next login
            </label>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button disabled={busy || (mode === 'manual' && temporaryPassword.length === 0)} onClick={submit}>
                {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Reset password
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function RoleEditor({ user, roles, onClose, onSaved }: { user: RbacUser; roles: RbacRole[]; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set(user.roles.map((r) => r.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  function toggle(id: string) { setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  async function save() {
    setBusy(true); setError(null);
    try { await rbacApi.setRoles(user.id, [...selected]); toast.success(`Roles updated for ${user.name}.`); onSaved(); }
    catch (e) { const m = e instanceof ApiError ? e.message : 'Failed to update roles.'; setError(m); toast.error(m); }
    finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">Roles for {user.name}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{user.email}</p>
        <div className="grid gap-2">
          {roles.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 hover:bg-muted/40">
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="mt-1" />
              <span>
                <span className="flex items-center gap-2 text-sm font-medium">{r.name} <Badge variant="neutral">{SCOPE_LABEL[r.scope] ?? r.scope}</Badge></span>
                <span className="block text-xs text-muted-foreground">{r.description}</span>
              </span>
            </label>
          ))}
        </div>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={save}>{busy ? <Loader2 className="animate-spin" /> : <Check />} Save roles</Button>
        </div>
      </Card>
    </div>
  );
}

function UserDetailDrawer({ user, onClose }: { user: RbacUser; onClose: () => void }): JSX.Element {
  const [detail, setDetail] = useState<RbacUserDetail | null>(null);
  useEffect(() => { rbacApi.user(user.id).then(setDetail).catch(() => setDetail(null)); }, [user.id]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative flex h-full w-full max-w-sm flex-col overflow-hidden border-l border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-border p-4">
          <div><h2 className="text-lg font-bold">{user.name}</h2><p className="text-xs text-muted-foreground">{user.email}</p></div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"><X className="size-5" /></button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {!detail ? <Skeleton className="h-40 w-full" /> : (
            <>
              <div className="flex flex-wrap gap-1">{detail.roles.map((r) => <Badge key={r.id} variant={ROLE_VARIANT[r.name] ?? 'neutral'}>{r.name}</Badge>)}</div>
              <p className="mt-2 text-sm"><span className="text-muted-foreground">Data scope: </span><span className="font-medium">{SCOPE_LABEL[detail.scope] ?? detail.scope}</span></p>
              <h3 className="mb-2 mt-4 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground"><KeyRound className="size-3.5" /> Effective permissions ({detail.permissions.length})</h3>
              <div className="grid gap-1">
                {detail.permissions.length === 0 ? <p className="text-sm text-muted-foreground">No permissions (no role assigned).</p> :
                  detail.permissions.map((p) => <code key={p} className="rounded bg-muted px-2 py-1 text-xs">{p}</code>)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------- Roles & matrix -------------------------- */
function RolesTab(): JSX.Element {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [roles, setRoles] = useState<RbacRole[]>([]);
  useEffect(() => { rbacApi.matrix().then(setMatrix).catch(() => setMatrix(null)); rbacApi.roles().then(setRoles).catch(() => setRoles([])); }, []);
  const roleOrder = useMemo(() => ['Super Admin', 'HR/Admin', 'Manager', 'Employee', 'Viewer'], []);
  const orderedRoles = useMemo(() => (matrix ? [...matrix.roles].sort((a, b) => roleOrder.indexOf(a.name) - roleOrder.indexOf(b.name)) : []), [matrix, roleOrder]);

  if (!matrix) return <Card className="p-6"><Skeleton className="h-64 w-full" /></Card>;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[...roles].sort((a, b) => roleOrder.indexOf(a.name) - roleOrder.indexOf(b.name)).map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">{r.name}</h3>
              <Badge variant={ROLE_VARIANT[r.name] ?? 'neutral'}>{SCOPE_LABEL[r.scope] ?? r.scope}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
            <p className="mt-2 text-xs text-muted-foreground">{r.permissionCount} permissions · {r.users} user{r.users === 1 ? '' : 's'}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border p-3"><h3 className="text-sm font-bold">Role × permission matrix</h3><p className="text-xs text-muted-foreground">Read-only. Predefined roles have fixed permission sets, grouped by module.</p></div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="p-3">Permission</th>
                {orderedRoles.map((r) => <th key={r.id} className="p-3 text-center">{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {matrix.groups.map((g) => (
                <Fragment key={g.label}>
                  <tr className="bg-muted/40"><td className="p-2 text-xs font-bold uppercase tracking-wide text-muted-foreground" colSpan={orderedRoles.length + 1}>{g.label}</td></tr>
                  {g.permissions.map((p) => (
                    <tr key={p.code} className="border-t border-border">
                      <td className="p-2"><span className="text-xs">{p.description}</span><code className="ml-2 rounded bg-muted px-1 text-[10px] text-muted-foreground">{p.code}</code></td>
                      {orderedRoles.map((r) => (
                        <td key={r.id} className="p-2 text-center">
                          {matrix.grants[r.id]?.includes(p.code) ? <Check className="mx-auto size-4 text-emerald-600" /> : <span className="text-muted-foreground/30">·</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
