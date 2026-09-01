import { useMemo } from 'react';
import { Info, Layers, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { competencyApi } from '../api';
import { versionStatusBadge, versionStatusLabel } from '../badges';
import { useIndicators } from '../hooks';
import type { BehaviourIndicator, CompetencyVersion, IndicatorType } from '../types';
import { IndicatorColumn } from './IndicatorColumn';

interface BehaviourIndicatorsEditorProps {
  /** The version whose indicators are being edited/viewed. */
  version: CompetencyVersion | null;
  competencyName?: string;
}

/**
 * Restyled behaviour indicators editor (Session 3). Shows the proficiency-level
 * reference (data-driven from the version) and two indicator columns. Editing
 * is enabled only for DRAFT versions — active/retired versions are immutable,
 * matching the version-lifecycle rule in the handoff.
 */
export function BehaviourIndicatorsEditor({
  version,
  competencyName,
}: BehaviourIndicatorsEditorProps): JSX.Element {
  const { data: indicators, loading, error, reload } = useIndicators(version?.id ?? null);
  const editable = version?.status === 'draft';

  const grouped = useMemo(() => splitByType(indicators ?? []), [indicators]);

  if (!version) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-10 text-center">
        <Layers className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">Select a competency</p>
        <p className="text-sm text-muted-foreground">
          Choose a competency to view or edit its behaviour indicators.
        </p>
      </div>
    );
  }

  async function handleAdd(type: IndicatorType, text: string, proficiencyLevelId: string | null): Promise<void> {
    await competencyApi.addIndicator(version!.id, { type, text, proficiencyLevelId });
    reload();
  }

  async function handleRemove(indicator: BehaviourIndicator): Promise<void> {
    await competencyApi.deleteIndicator(indicator.id);
    reload();
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold">{competencyName ?? 'Behaviour indicators'}</h3>
        <Badge variant="brand">{version.versionLabel}</Badge>
        <Badge variant={versionStatusBadge(version.status)}>{versionStatusLabel(version.status)}</Badge>
        {!editable ? (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3.5" /> Read-only — use New version on the Library tab to edit
          </span>
        ) : null}
      </div>

      <ProficiencyLegend version={version} />

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-600/20">{error}</p>
      ) : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <IndicatorColumn
            type="positive"
            indicators={grouped.positive}
            proficiencyLevels={version.proficiencyLevels}
            editable={editable}
            onAdd={(text, levelId) => handleAdd('positive', text, levelId)}
            onRemove={handleRemove}
          />
          <IndicatorColumn
            type="negative"
            indicators={grouped.negative}
            proficiencyLevels={version.proficiencyLevels}
            editable={editable}
            onAdd={(text, levelId) => handleAdd('negative', text, levelId)}
            onRemove={handleRemove}
          />
        </div>
      )}
    </div>
  );
}

function splitByType(indicators: BehaviourIndicator[]): Record<IndicatorType, BehaviourIndicator[]> {
  return {
    positive: indicators.filter((i) => i.type === 'positive').sort((a, b) => a.sortOrder - b.sortOrder),
    negative: indicators.filter((i) => i.type === 'negative').sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function ProficiencyLegend({ version }: { version: CompetencyVersion }): JSX.Element | null {
  if (version.proficiencyLevels.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <Info className="size-3.5" /> Proficiency levels
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {[...version.proficiencyLevels]
          .sort((a, b) => a.level - b.level)
          .map((level) => (
            <div key={level.id} className="rounded-md bg-card p-2.5 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-indigo-50 text-xs font-bold text-brand">
                  {level.level}
                </span>
                <span className="text-sm font-semibold">{level.name}</span>
              </div>
              {level.description ? (
                <p className="mt-1 text-xs text-muted-foreground">{level.description}</p>
              ) : null}
            </div>
          ))}
      </div>
    </div>
  );
}
