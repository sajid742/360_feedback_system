import { useEffect, useState } from 'react';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { appraisalApi, type Cycle } from '@/features/appraisal/api';
import { usePermissions } from '@/features/auth/AuthContext';
import { reportsApi } from './api';
import { CampusTab, DepartmentalTab, HeatmapTab, IndividualTab, InstitutionalTab, MyTeamTab, NineBoxTab, SchedulesTab, TrendTab } from './tabs';

export function ReportsPage(): JSX.Element {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cycleId, setCycleId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Only offer what this user can actually open (F-H5). Nine-box, schedules and the
  // exports are executive/HR-only, so for a manager or employee they previously
  // rendered as a permanently blank tab with no explanation.
  const { has } = usePermissions();
  const isExecutive = has('reports.executive');
  const canSchedule = has('reports.manage');

  useEffect(() => {
    appraisalApi.listCycles().then(setCycles);
  }, []);

  const doExport = async (format: 'csv' | 'xlsx'): Promise<void> => {
    setBusy(true);
    try {
      await reportsApi.exportFile('institutional', format, cycleId || undefined);
      await reportsApi.exportFile('departmental', format, cycleId || undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 print:gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Reports & Dashboards</h1>
          <p className="text-sm text-muted-foreground">360° analytics across the institution, departments, and individuals.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2 print:hidden">
            {/* Data exports contain named individuals, so they are executive/HR-only. */}
            {isExecutive ? (
              <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => doExport('xlsx')} title="Download Excel">
                  <FileSpreadsheet className="mr-1 size-3.5" />Excel
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => doExport('csv')} title="Download CSV">
                  <Download className="mr-1 size-3.5" />CSV
                </Button>
              </>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => window.print()} title="Print or save as PDF">
              <Printer className="mr-1 size-3.5" />PDF
            </Button>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="cycle" className="text-xs">Appraisal cycle</Label>
            <select id="cycle" value={cycleId} onChange={(e) => setCycleId(e.target.value)} className="h-10 rounded-md border border-input bg-card px-3 text-sm">
              <option value="">All cycles</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="institutional">
          <TabsList className="flex-wrap">
            <TabsTrigger value="institutional">Institutional</TabsTrigger>
            <TabsTrigger value="myteam">My Team</TabsTrigger>
            <TabsTrigger value="departmental">Departmental</TabsTrigger>
            <TabsTrigger value="campus">Campus</TabsTrigger>
            <TabsTrigger value="individual">Individual</TabsTrigger>
            <TabsTrigger value="heatmap">Heatmap</TabsTrigger>
            {isExecutive ? <TabsTrigger value="ninebox">Nine-box</TabsTrigger> : null}
            <TabsTrigger value="trend">Trend</TabsTrigger>
            {canSchedule ? <TabsTrigger value="schedules">Schedules</TabsTrigger> : null}
          </TabsList>
          <TabsContent value="institutional"><InstitutionalTab cycleId={cycleId || undefined} /></TabsContent>
          <TabsContent value="myteam"><MyTeamTab cycleId={cycleId || undefined} /></TabsContent>
          <TabsContent value="departmental"><DepartmentalTab cycleId={cycleId || undefined} /></TabsContent>
          <TabsContent value="campus"><CampusTab cycleId={cycleId || undefined} /></TabsContent>
          <TabsContent value="individual"><IndividualTab cycleId={cycleId || undefined} /></TabsContent>
          <TabsContent value="heatmap"><HeatmapTab cycleId={cycleId || undefined} /></TabsContent>
          {isExecutive ? <TabsContent value="ninebox"><NineBoxTab cycleId={cycleId || undefined} /></TabsContent> : null}
          <TabsContent value="trend"><TrendTab /></TabsContent>
          {canSchedule ? <TabsContent value="schedules"><SchedulesTab /></TabsContent> : null}
        </Tabs>
      </Card>
    </div>
  );
}
