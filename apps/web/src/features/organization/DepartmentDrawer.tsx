import { useEffect } from 'react';
import { Building2, Layers, MapPin, UserRound, Users, X } from 'lucide-react';
import type { DepartmentNode } from './api';

/** Slide-in detail panel for a department node. Shows the unit's identity, its
 *  head, headcounts, and its immediate sub-units. Read-only view over data the
 *  chart already holds — no extra fetch. */
export function DepartmentDrawer({ dept, onClose, onSelect }: {
  dept: DepartmentNode | null;
  onClose: () => void;
  onSelect: (d: DepartmentNode) => void;
}): JSX.Element | null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!dept) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative flex h-full w-full max-w-sm flex-col overflow-hidden border-l border-border bg-card shadow-2xl animate-in slide-in-from-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Building2 className="size-6" />
            </span>
            <div>
              <h2 className="text-lg font-bold leading-tight">{dept.name}</h2>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{dept.unitType}</span>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={<Users className="size-4" />} label="Direct members" value={dept.employeeCount} />
            <Stat icon={<Layers className="size-4" />} label="Incl. sub-units" value={dept.totalEmployeeCount} />
          </div>

          <Section title="Head of Department">
            {dept.hodName ? (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
                <span className="flex size-9 items-center justify-center rounded-full bg-brand/10 text-brand">
                  <UserRound className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{dept.hodName}</p>
                  <p className="truncate text-xs text-muted-foreground">{dept.hodDesignation ?? 'Designation not set'}</p>
                </div>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm italic text-muted-foreground">No head assigned to this unit.</p>
            )}
          </Section>

          {dept.campusName ? (
            <Section title="Campus">
              <p className="flex items-center gap-2 text-sm"><MapPin className="size-4 text-muted-foreground" />{dept.campusName}</p>
            </Section>
          ) : null}

          <Section title={`Sub-units (${dept.children.length})`}>
            {dept.children.length === 0 ? (
              <p className="text-sm text-muted-foreground">This is a leaf unit — no sub-units.</p>
            ) : (
              <div className="grid gap-2">
                {dept.children.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => onSelect(c)}
                    className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{c.hodName ?? 'No head'} · {c.unitType}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                      <Users className="size-3" />{c.totalEmployeeCount}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">{icon}<span className="text-xs">{label}</span></div>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
