import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Link as LinkIcon, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api-client';
import { identityApi, type IdentityEmployee, type TeacherMapping } from './api';

const selectClass =
  'h-9 rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Teacher ↔ Employee identity mapping. Each SIS teacher is linked to exactly one
 * 360 employee via an explicit, admin-confirmed record (keyed on employee code —
 * never names). A code match is only a *suggestion*; the admin confirms it.
 */
export function TeacherMappingPanel(): JSX.Element {
  const [rows, setRows] = useState<TeacherMapping[] | null>(null);
  const [employees, setEmployees] = useState<IdentityEmployee[] | null>(null);
  // The employee dropdown is served by a bounded, searchable lookup (F25) — it used
  // to load the whole directory behind a silent 2,000-row cap, so in a large
  // organisation the person you needed simply wasn't in the list.
  const [employeeTruncated, setEmployeeTruncated] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    identityApi.teacherMapping().then((r) => {
      setRows(r);
      // Pre-fill each dropdown with the current mapping, else the code suggestion.
      const d: Record<string, string> = {};
      for (const t of r) d[t.teacherId] = t.mappedEmployeeId ?? t.suggestedEmployeeId ?? '';
      setDraft(d);
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const timer = setTimeout(() => {
      identityApi
        .employees(employeeSearch || undefined)
        .then((r) => { setEmployees(r.items); setEmployeeTruncated(r.truncated); })
        .catch(() => setEmployees([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [employeeSearch]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((t) => t.teacherName.toLowerCase().includes(q) || (t.employeeCode ?? '').toLowerCase().includes(q));
  }, [rows, search]);

  const stats = useMemo(() => {
    if (!rows) return { mapped: 0, total: 0 };
    return { mapped: rows.filter((r) => r.mappedEmployeeId).length, total: rows.length };
  }, [rows]);

  async function save(t: TeacherMapping): Promise<void> {
    const employeeId = draft[t.teacherId];
    if (!employeeId) return;
    setBusy(t.teacherId);
    setError(null);
    try {
      await identityApi.save({ externalId: t.teacherId, externalCode: t.employeeCode ?? undefined, employeeId });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save mapping.');
    } finally {
      setBusy(null);
    }
  }

  async function clear(t: TeacherMapping): Promise<void> {
    setBusy(t.teacherId);
    try {
      await identityApi.clear(t.teacherId);
      reload();
    } finally {
      setBusy(null);
    }
  }

  if (!rows || !employees) return <Skeleton className="h-72 w-full" />;

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Teacher ↔ Employee mapping</h3>
          <p className="text-xs text-muted-foreground">
            Parent feedback is recorded against the mapped 360 employee. A teacher must be mapped before links can be generated.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={stats.mapped === stats.total ? 'success' : 'warning'}>
            {stats.mapped}/{stats.total} mapped
          </Badge>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search teacher / code" className="h-9 w-48" />
          <Input value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} placeholder="Filter employee list" className="h-9 w-48" />
        </div>
      </div>
      {employeeTruncated ? (
        <p className="mb-2 text-xs text-muted-foreground">
          The employee dropdown shows the first {employees?.length ?? 0} matches. Use “Filter employee list” to narrow it if
          the person you need isn’t there.
        </p>
      ) : null}
      {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">SIS Teacher</th>
              <th className="p-3">Emp. code</th>
              <th className="p-3">Mapped 360 employee</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const isMapped = Boolean(t.mappedEmployeeId);
              const value = draft[t.teacherId] ?? '';
              const dirty = value !== (t.mappedEmployeeId ?? '');
              return (
                <tr key={t.teacherId} className="border-t border-border">
                  <td className="p-3">
                    <p className="font-medium">{t.teacherName}</p>
                    {t.designation ? <p className="text-xs text-muted-foreground">{t.designation}</p> : null}
                  </td>
                  <td className="p-3 font-mono text-xs">{t.employeeCode ?? '—'}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <select
                        value={value}
                        onChange={(e) => setDraft((d) => ({ ...d, [t.teacherId]: e.target.value }))}
                        className={selectClass}
                      >
                        <option value="">— not mapped —</option>
                        {employees.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name} ({e.employeeCode})
                          </option>
                        ))}
                      </select>
                      {isMapped ? (
                        <Badge variant="success">
                          <Check className="mr-1 size-3" /> mapped
                        </Badge>
                      ) : t.suggestedEmployeeId ? (
                        <Badge variant="info">suggested: {t.suggestedEmployeeName}</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" disabled={busy !== null || !value || !dirty} onClick={() => save(t)}>
                        <LinkIcon /> Save
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy !== null || !isMapped} onClick={() => clear(t)}>
                        <X /> Clear
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
