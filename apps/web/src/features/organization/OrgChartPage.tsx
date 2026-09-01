import { useEffect, useState } from 'react';
import { Network, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { orgApi, type DepartmentNode, type Employee } from './api';
import { OrgChart } from './OrgChart';
import { DepartmentOrgChart } from './DepartmentOrgChart';
import { DepartmentDrawer } from './DepartmentDrawer';

/**
 * Org Chart as a page in its own right.
 *
 * This is the same component that used to be the fifth tab on the Organization page,
 * moved rather than rewritten: the two charts (`DepartmentOrgChart`, `OrgChart`), the
 * department drawer and both API calls are unchanged, so every existing behaviour —
 * unit and people views, search, expand/collapse, pan and zoom, the drawer and its
 * cross-navigation, line-manager versus matrix edges — comes with it untouched.
 *
 * It reads the same two endpoints as before (`/organization/departments/tree` and
 * `/organization/org-chart`), both gated by `organization.read`, which is why the new
 * navigation entry carries that same permission and no backend change was needed.
 */
type ChartView = 'units' | 'people';

export function OrgChartPage(): JSX.Element {
  const [view, setView] = useState<ChartView>('units');
  const [roots, setRoots] = useState<DepartmentNode[] | null>(null);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [selected, setSelected] = useState<DepartmentNode | null>(null);

  useEffect(() => {
    orgApi.deptTree().then(setRoots).catch(() => setRoots([]));
  }, []);
  // The people chart is fetched only when that view is first opened, as before.
  useEffect(() => {
    if (view === 'people' && employees === null) orgApi.orgChart().then(setEmployees).catch(() => setEmployees([]));
  }, [view, employees]);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Org Chart</h1>
        <p className="text-sm text-muted-foreground">
          The organisation as a picture — units and the reporting lines between people.
        </p>
      </div>

      <Card className="p-4 sm:p-5">
        <div className="grid gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {view === 'units'
                ? 'Explore the organization by unit — click a card for details, search by department or head, expand and collapse branches.'
                : 'Reporting lines between people. Solid = line manager, dashed = matrix (dotted-line) manager.'}
            </p>
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-sm">
              <ViewButton active={view === 'units'} onClick={() => setView('units')} icon={<Network className="size-4" />}>Units</ViewButton>
              <ViewButton active={view === 'people'} onClick={() => setView('people')} icon={<Users className="size-4" />}>People</ViewButton>
            </div>
          </div>

          {view === 'units' ? (
            roots === null ? (
              <Skeleton className="h-[640px] w-full" />
            ) : (
              <>
                <DepartmentOrgChart roots={roots} onOpen={setSelected} />
                <DepartmentDrawer dept={selected} onClose={() => setSelected(null)} onSelect={setSelected} />
              </>
            )
          ) : employees === null ? (
            <Skeleton className="h-[600px] w-full" />
          ) : (
            <OrgChart employees={employees} />
          )}
        </div>
      </Card>
    </div>
  );
}

function ViewButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {icon}
      {children}
    </button>
  );
}
