import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Plus, Trash2 } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { orgApi, type Employee } from '@/features/organization/api';
import { developmentApi, type DevelopmentAction } from './api';

const STATUS_LABEL: Record<DevelopmentAction['status'], string> = { open: 'Open', in_progress: 'In progress', done: 'Done' };
const STATUS_NEXT: Record<DevelopmentAction['status'], DevelopmentAction['status']> = { open: 'in_progress', in_progress: 'done', done: 'open' };
const PRIORITY_VARIANT: Record<DevelopmentAction['priority'], BadgeVariant> = { high: 'danger', medium: 'warning', low: 'success' };

export function DevelopmentPage(): JSX.Element {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [actions, setActions] = useState<DevelopmentAction[] | null>(null);
  const [form, setForm] = useState({ title: '', competency: '', priority: 'medium', dueDate: '' });

  const reload = useCallback(() => developmentApi.list(employeeId || undefined).then(setActions), [employeeId]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    orgApi.listEmployees('').then((r) => setEmployees(r.items));
  }, []);

  const add = async (): Promise<void> => {
    if (!employeeId || !form.title.trim()) return;
    await developmentApi.create({
      employeeId,
      title: form.title.trim(),
      competency: form.competency.trim() || undefined,
      priority: form.priority as DevelopmentAction['priority'],
      dueDate: form.dueDate || undefined,
    });
    setForm({ title: '', competency: '', priority: 'medium', dueDate: '' });
    reload();
  };

  const cycleStatus = async (a: DevelopmentAction): Promise<void> => {
    await developmentApi.update(a.id, { status: STATUS_NEXT[a.status] });
    reload();
  };

  const remove = async (id: string): Promise<void> => {
    await developmentApi.remove(id);
    reload();
  };

  return (
    <div className="grid gap-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><ClipboardList className="size-4" /></span>
          <h1 className="text-2xl font-extrabold tracking-tight">Development Plans</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Turn 360° feedback into trackable development actions with owners, priorities, and due dates.</p>
      </div>

      <Card className="p-4 sm:p-5">
        <div className="grid gap-3">
          <div className="grid gap-1 sm:max-w-sm">
            <Label htmlFor="emp" className="text-xs">Employee</Label>
            <select id="emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="h-10 rounded-md border border-input bg-card px-3 text-sm">
              <option value="">All employees</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.user.fullName ?? e.user.email}</option>
              ))}
            </select>
          </div>

          {employeeId ? (
            <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-[2fr_1fr_auto_auto]">
              <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Action (e.g. Attend leadership workshop)" />
              <Input value={form.competency} onChange={(e) => setForm((f) => ({ ...f, competency: e.target.value }))} placeholder="Competency (optional)" />
              <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} className="h-10 rounded-md border border-input bg-card px-2 text-sm">
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <Button onClick={add}><Plus /> Add</Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Select an employee to add a development action.</p>
          )}
        </div>
      </Card>

      {!actions ? (
        <Skeleton className="h-40 w-full" />
      ) : actions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">No development actions yet.</p>
      ) : (
        <div className="grid gap-2">
          {actions.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 shadow-card">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{a.title}</p>
                <p className="text-xs text-muted-foreground">
                  {a.employeeName ? `${a.employeeName} · ` : ''}{a.competency ?? 'General'}{a.dueDate ? ` · due ${new Date(a.dueDate).toLocaleDateString()}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={PRIORITY_VARIANT[a.priority]}>{a.priority}</Badge>
                <button onClick={() => cycleStatus(a)} title="Click to advance status">
                  <Badge variant={a.status === 'done' ? 'success' : a.status === 'in_progress' ? 'info' : 'neutral'}>{STATUS_LABEL[a.status]}</Badge>
                </button>
                <Button variant="ghost" size="sm" onClick={() => remove(a.id)}><Trash2 className="size-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
