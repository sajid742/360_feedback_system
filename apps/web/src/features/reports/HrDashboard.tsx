import { Users } from 'lucide-react';
import { ConfigurableDashboard } from './dashboard/ConfigurableDashboard';
import { HR_DEFAULT_LAYOUT, HR_WIDGETS } from './dashboard/hr-widgets';
import { reportsApi, type Hr } from './api';

/** HR dashboard (role-gated by reports.executive). Now a configurable layout of the
 *  existing operational HR widgets — same data, drill-downs and cycle filter. */
export function HrDashboard(): JSX.Element {
  return (
    <ConfigurableDashboard<Hr>
      type="hr"
      title="HR Dashboard"
      description="Operational view for HR — outstanding reviews, department performance, training needs and calibration progress."
      icon={<Users className="size-4" />}
      widgets={HR_WIDGETS}
      defaultLayout={HR_DEFAULT_LAYOUT}
      fetchData={reportsApi.hr}
      targetOf={(d) => d.target}
    />
  );
}
