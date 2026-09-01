import { LayoutDashboard } from 'lucide-react';
import { ConfigurableDashboard } from './dashboard/ConfigurableDashboard';
import { EXECUTIVE_DEFAULT_LAYOUT, EXECUTIVE_WIDGETS } from './dashboard/executive-widgets';
import { reportsApi, type Executive } from './api';

/** Executive cockpit (role-gated by reports.executive). Now a configurable layout
 *  of the existing KPIs/charts/lists — same data, drill-downs and cycle filter. */
export function ExecutiveDashboard(): JSX.Element {
  return (
    <ConfigurableDashboard<Executive>
      type="executive"
      title="Executive Dashboard"
      description="Organisation-wide performance at a glance — KPIs, trends, and comparison across departments and campuses."
      icon={<LayoutDashboard className="size-4" />}
      widgets={EXECUTIVE_WIDGETS}
      defaultLayout={EXECUTIVE_DEFAULT_LAYOUT}
      fetchData={reportsApi.executive}
      targetOf={(d) => d.target}
    />
  );
}
