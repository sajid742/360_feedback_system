import { FileEdit, FolderTree, Layers } from 'lucide-react';
import { StatCard } from '@/components/shared/StatCard';
import { useCompetencyStats } from '../hooks';

/**
 * Gradient KPI row for the Competency module. Values are fetched from the stats
 * endpoint — no hardcoded numbers.
 *
 * There used to be a fourth card, "Mapped designations", counting the job titles with
 * at least one competency linked to them via `competency_designation_mappings`. It has
 * been removed because the application offers no way to CREATE such a mapping — there
 * is no endpoint and no screen — so the number could only ever be whatever the demo
 * seed happened to insert, and exactly zero for a real client. The table and its model
 * remain (see stats.service.ts) for the role-profile feature they were groundwork for;
 * this row simply stops advertising a figure nobody can influence.
 */
export function CompetencyStatsRow({ refreshToken = 0 }: { refreshToken?: number }): JSX.Element {
  const { data, loading } = useCompetencyStats(refreshToken);

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <StatCard
        label="Competencies"
        value={data?.totalCompetencies ?? 0}
        hint={`${data?.activeCompetencies ?? 0} active`}
        tone="brand"
        icon={<Layers />}
        loading={loading}
      />
      <StatCard
        label="Categories"
        value={data?.categories ?? 0}
        tone="teal"
        icon={<FolderTree />}
        loading={loading}
      />
      <StatCard
        label="Draft versions"
        value={data?.draftVersions ?? 0}
        hint="Editable"
        tone="amber"
        icon={<FileEdit />}
        loading={loading}
      />
    </div>
  );
}
