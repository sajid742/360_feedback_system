import { useCallback, useEffect, useState } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { workflowApi, type DefinitionSummary, type StepInput, type WorkflowTask } from './api';

export function WorkflowPage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Workflows</h1>
        <p className="text-sm text-muted-foreground">Approval routing and the tasks assigned to you.</p>
      </div>
      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="approvals">
          <TabsList>
            <TabsTrigger value="approvals">My Approvals</TabsTrigger>
            <TabsTrigger value="definitions">Definitions</TabsTrigger>
          </TabsList>
          <TabsContent value="approvals">
            <MyApprovalsPanel />
          </TabsContent>
          <TabsContent value="definitions">
            <DefinitionsPanel />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}

function MyApprovalsPanel(): JSX.Element {
  const [tasks, setTasks] = useState<WorkflowTask[] | null>(null);

  const reload = useCallback(() => {
    workflowApi.myTasks().then(setTasks);
  }, []);
  useEffect(() => reload(), [reload]);

  async function act(id: string, decision: 'approve' | 'reject'): Promise<void> {
    await workflowApi.act(id, decision);
    reload();
  }

  if (!tasks) return <Skeleton className="h-40 w-full" />;
  if (tasks.length === 0) {
    return <p className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">No pending approvals.</p>;
  }
  return (
    <div className="grid gap-2">
      {tasks.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
          <div className="min-w-0">
            <p className="font-semibold">{t.workflow}</p>
            <p className="text-xs text-muted-foreground">
              {t.step} · {t.entityType} · {new Date(t.createdAt).toLocaleString()}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => act(t.id, 'approve')}>
              <Check /> Approve
            </Button>
            <Button size="sm" variant="outline" className="text-red-600" onClick={() => act(t.id, 'reject')}>
              <X /> Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DefinitionsPanel(): JSX.Element {
  const [defs, setDefs] = useState<DefinitionSummary[] | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(() => {
    workflowApi.listDefinitions().then(setDefs);
  }, []);
  useEffect(() => reload(), [reload]);

  if (!defs) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus /> New definition
        </Button>
      </div>
      <div className="grid gap-2">
        {defs.map((d) => (
          <div key={d.id} className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
            <div>
              <p className="font-semibold">{d.name}</p>
              <p className="text-xs text-muted-foreground">
                {d.entityType} · {d.mode} · {d.steps} steps
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={d.isActive ? 'success' : 'neutral'}>{d.isActive ? 'Active' : 'Inactive'}</Badge>
              <button onClick={() => workflowApi.deleteDefinition(d.id).then(reload)} aria-label="Delete" className="text-muted-foreground hover:text-red-600">
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
        ))}
        {defs.length === 0 ? <p className="text-sm text-muted-foreground">No workflow definitions yet.</p> : null}
      </div>
      <CreateDefinitionDialog open={open} onOpenChange={setOpen} onSaved={reload} />
    </div>
  );
}

function CreateDefinitionDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('appraisal');
  const [mode, setMode] = useState<'sequential' | 'parallel'>('sequential');
  const [steps, setSteps] = useState<StepInput[]>([{ name: 'Approval', stepOrder: 1, assigneeType: 'role', assigneeValue: '' }]);

  useEffect(() => {
    if (open) {
      setName('');
      setEntityType('appraisal');
      setMode('sequential');
      setSteps([{ name: 'Approval', stepOrder: 1, assigneeType: 'role', assigneeValue: '' }]);
    }
  }, [open]);

  function addStep(): void {
    setSteps((s) => [...s, { name: '', stepOrder: s.length + 1, assigneeType: 'role', assigneeValue: '' }]);
  }
  function updateStep(index: number, patch: Partial<StepInput>): void {
    setSteps((s) => s.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim()) return;
    await workflowApi.createDefinition({
      name: name.trim(),
      entityType: entityType.trim(),
      mode,
      steps: steps.map((s, i) => ({ ...s, stepOrder: i + 1, assigneeValue: s.assigneeValue || undefined })),
    });
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New workflow definition</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="wname">Name</Label>
              <Input id="wname" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wentity">Entity type</Label>
              <Input id="wentity" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="wmode">Mode</Label>
            <select id="wmode" value={mode} onChange={(e) => setMode(e.target.value as 'sequential' | 'parallel')} className="h-10 rounded-md border border-input bg-card px-3 text-sm">
              <option value="sequential">Sequential</option>
              <option value="parallel">Parallel</option>
            </select>
          </div>
          <div className="grid gap-2">
            <Label>Steps (assignee value = role or user UUID)</Label>
            {steps.map((step, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1.4fr] gap-2">
                <Input value={step.name} onChange={(e) => updateStep(i, { name: e.target.value })} placeholder={`Step ${i + 1}`} />
                <select value={step.assigneeType} onChange={(e) => updateStep(i, { assigneeType: e.target.value as 'role' | 'user' })} className="h-10 rounded-md border border-input bg-card px-2 text-sm">
                  <option value="role">Role</option>
                  <option value="user">User</option>
                </select>
                <Input value={step.assigneeValue} onChange={(e) => updateStep(i, { assigneeValue: e.target.value })} placeholder="assignee UUID" />
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={addStep}>
              <Plus /> Add step
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
