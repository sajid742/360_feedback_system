import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmployeesPanel } from './panels/EmployeesPanel';
import { CampusesPanel, DepartmentsPanel, DesignationsPanel } from './panels/StructurePanels';

/**
 * Organization — the people and structure the rest of the system builds on.
 *
 * The Org Chart used to be a fifth tab here. It is now a page in its own right
 * (`/org-chart`, `OrgChartPage`) because it is something people go to *look at*,
 * not something they come here to configure. This page keeps the management
 * surfaces; the chart kept all of its behaviour — it was moved, not rewritten.
 */
export function OrganizationPage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Organization</h1>
        <p className="text-sm text-muted-foreground">People, structure, and reporting lines.</p>
      </div>
      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="employees">
          <TabsList>
            <TabsTrigger value="employees">Employees</TabsTrigger>
            <TabsTrigger value="departments">Departments</TabsTrigger>
            <TabsTrigger value="designations">Designations</TabsTrigger>
            <TabsTrigger value="campuses">Campuses</TabsTrigger>
          </TabsList>
          <TabsContent value="employees">
            <EmployeesPanel />
          </TabsContent>
          <TabsContent value="departments">
            <DepartmentsPanel />
          </TabsContent>
          <TabsContent value="designations">
            <DesignationsPanel />
          </TabsContent>
          <TabsContent value="campuses">
            <CampusesPanel />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
