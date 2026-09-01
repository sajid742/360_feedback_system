import { useCallback, useEffect, useState } from 'react';
import { Building, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { orgApi, type Campus, type DepartmentNode, type Designation } from '../api';

export function DepartmentsPanel(): JSX.Element {
  const [tree, setTree] = useState<DepartmentNode[] | null>(null);
  const [name, setName] = useState('');

  const reload = useCallback(() => {
    orgApi.deptTree().then(setTree);
  }, []);
  useEffect(() => reload(), [reload]);

  async function add(): Promise<void> {
    if (!name.trim()) return;
    await orgApi.createDept({ name: name.trim() });
    setName('');
    reload();
  }
  async function remove(id: string): Promise<void> {
    await orgApi.deleteDept(id);
    reload();
  }

  if (!tree) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New top-level department" />
        <Button onClick={add}>
          <Plus /> Add
        </Button>
      </div>
      <div className="grid gap-1">
        {tree.map((node) => (
          <DeptRow key={node.id} node={node} depth={0} onRemove={remove} />
        ))}
        {tree.length === 0 ? <p className="text-sm text-muted-foreground">No departments yet.</p> : null}
      </div>
    </div>
  );
}

function DeptRow({ node, depth, onRemove }: { node: DepartmentNode; depth: number; onRemove: (id: string) => void }): JSX.Element {
  return (
    <>
      <div
        className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2"
        style={{ marginLeft: depth * 20 }}
      >
        <div className="flex items-center gap-2">
          {depth > 0 ? <ChevronRight className="size-3.5 text-muted-foreground" /> : null}
          <span className="text-sm font-medium">{node.name}</span>
          <Badge variant="info">{node.unitType}</Badge>
        </div>
        <button onClick={() => onRemove(node.id)} aria-label="Delete" className="text-muted-foreground hover:text-red-600">
          <Trash2 className="size-4" />
        </button>
      </div>
      {node.children.map((child) => (
        <DeptRow key={child.id} node={child} depth={depth + 1} onRemove={onRemove} />
      ))}
    </>
  );
}

export function DesignationsPanel(): JSX.Element {
  const [items, setItems] = useState<Designation[] | null>(null);
  const [name, setName] = useState('');
  const [level, setLevel] = useState('0');

  const reload = useCallback(() => {
    orgApi.listDesignations().then(setItems);
  }, []);
  useEffect(() => reload(), [reload]);

  async function add(): Promise<void> {
    if (!name.trim()) return;
    await orgApi.createDesignation({ name: name.trim(), level: Number(level) || 0 });
    setName('');
    setLevel('0');
    reload();
  }

  if (!items) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Designation name" />
        <Input value={level} onChange={(e) => setLevel(e.target.value)} placeholder="Level" className="w-24" type="number" />
        <Button onClick={add}>
          <Plus /> Add
        </Button>
      </div>
      <div className="grid gap-1">
        {items.map((d) => (
          <div key={d.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
            <span className="text-sm font-medium">{d.name}</span>
            <div className="flex items-center gap-2">
              <Badge variant="neutral">L{d.level}</Badge>
              <button onClick={() => orgApi.deleteDesignation(d.id).then(reload)} aria-label="Delete" className="text-muted-foreground hover:text-red-600">
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 ? <p className="text-sm text-muted-foreground">No designations yet.</p> : null}
      </div>
    </div>
  );
}

export function CampusesPanel(): JSX.Element {
  const [items, setItems] = useState<Campus[] | null>(null);
  const [form, setForm] = useState({ name: '', slug: '' });

  const reload = useCallback(() => {
    orgApi.listCampuses().then(setItems);
  }, []);
  useEffect(() => reload(), [reload]);

  async function add(): Promise<void> {
    if (!form.name.trim() || !form.slug.trim()) return;
    await orgApi.createCampus({ name: form.name.trim(), slug: form.slug.trim() });
    setForm({ name: '', slug: '' });
    reload();
  }

  if (!items) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Campus name" className="max-w-xs" />
        <Input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} placeholder="slug" className="max-w-[180px]" />
        <Button onClick={add}>
          <Plus /> Add
        </Button>
      </div>
      <div className="grid gap-1">
        {items.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
            <div className="flex items-center gap-2">
              <Building className="size-4 text-brand" />
              <span className="text-sm font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground">/{c.slug}</span>
            </div>
            <button onClick={() => orgApi.deleteCampus(c.id).then(reload)} aria-label="Delete" className="text-muted-foreground hover:text-red-600">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {items.length === 0 ? <p className="text-sm text-muted-foreground">No campuses yet.</p> : null}
      </div>
    </div>
  );
}
