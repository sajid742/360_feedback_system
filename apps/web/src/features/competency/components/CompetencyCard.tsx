import { Archive, CheckCircle2, CopyPlus, Pencil, Smile } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { versionStatusBadge, versionStatusLabel } from '../badges';
import type { Competency, CompetencyVersion } from '../types';

interface CompetencyCardProps {
  competency: Competency;
  onEdit: (competency: Competency) => void;
  onViewIndicators: (competency: Competency) => void;
  onArchive: (competency: Competency) => void;
  /** Publish the pending draft. Only offered when `pendingDraft(competency)` is non-null. */
  onActivate: (competency: Competency, draft: CompetencyVersion) => void;
  /** Clone the latest version into a new editable draft. */
  onNewVersion: (competency: Competency) => void;
  /** `competency.version.manage`. Without it neither version action is offered. */
  canManageVersions: boolean;
  busy?: boolean;
}

/**
 * The draft awaiting activation, or null.
 *
 * A competency can hold an active version AND a newer draft at the same time, and
 * `activeVersion` alone hides that — the card would read "Active" with no hint that
 * unpublished edits are sitting behind it. Only one draft can exist at a time
 * (`VersionService.cloneDraft` rejects a second), so the latest version being a draft
 * is the whole test.
 */
export function pendingDraft(competency: Competency): CompetencyVersion | null {
  const latest = competency.latestVersion;
  return latest && latest.status === 'draft' ? latest : null;
}

/**
 * Competency library card — soft status/category badges, version + proficiency
 * summary, and action buttons. Mirrors the reference "competency-card" layout
 * without copying its markup.
 */
export function CompetencyCard({
  competency,
  onEdit,
  onViewIndicators,
  onArchive,
  onActivate,
  onNewVersion,
  canManageVersions,
  busy = false,
}: CompetencyCardProps): JSX.Element {
  // A competency normally always has at least one live version — the create endpoint
  // makes a v1 draft. It can still be absent: every version soft-deleted, or a row
  // inserted by an import or script that skipped the version. Rendering must degrade
  // instead of throwing, because one such row would otherwise take down the whole
  // Competencies screen with "Cannot read properties of null".
  const displayVersion = competency.activeVersion ?? competency.latestVersion ?? null;
  const levelCount = displayVersion?.proficiencyLevels.length ?? 0;
  const draft = pendingDraft(competency);
  // A draft that is ALSO the displayed version is already described by the main badge;
  // the second badge only earns its place when it is hiding behind an active version.
  const showDraftPending = Boolean(draft && competency.activeVersion);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card p-5 shadow-card transition-shadow hover:shadow-card-hover">
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="font-bold leading-snug">{competency.name}</h3>
        {displayVersion ? (
          <Badge variant={versionStatusBadge(displayVersion.status)}>
            {versionStatusLabel(displayVersion.status)}
          </Badge>
        ) : (
          <Badge variant="warning">No version</Badge>
        )}
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <Badge variant="info">{competency.categoryName}</Badge>
        {competency.isMandatoryAnywhere ? <Badge variant="brand">Mandatory</Badge> : null}
        {showDraftPending && draft ? (
          <Badge variant="warning">{draft.versionLabel} draft pending</Badge>
        ) : null}
      </div>

      <p className="flex-grow text-sm text-muted-foreground">
        {competency.description ?? 'No description provided.'}
      </p>

      <div className="my-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>Version: {displayVersion?.versionLabel ?? '—'}</span>
        <span>{levelCount} proficiency levels</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onEdit(competency)}>
          <Pencil /> Edit
        </Button>
        <Button variant="outline" size="sm" onClick={() => onViewIndicators(competency)}>
          <Smile /> Indicators
        </Button>

        {canManageVersions && draft ? (
          <Button size="sm" disabled={busy} onClick={() => onActivate(competency, draft)}>
            <CheckCircle2 /> Activate
          </Button>
        ) : null}
        {canManageVersions && !draft && displayVersion ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onNewVersion(competency)}>
            <CopyPlus /> New version
          </Button>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={() => onArchive(competency)}
        >
          <Archive /> Archive
        </Button>
      </div>
    </div>
  );
}
