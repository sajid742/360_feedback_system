import { useMemo, useState } from 'react';
import { Layers, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { usePermissions } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api-client';
import { competencyApi } from '../api';
import { useCategories, useCompetencies } from '../hooks';
import type { Competency, CompetencyVersion } from '../types';
import { CompetencyCard, pendingDraft } from './CompetencyCard';
import { CompetencyFormDialog } from './CompetencyFormDialog';

interface CompetencyLibraryProps {
  onViewIndicators: (competency: Competency) => void;
  /**
   * Fired after any mutation so the page can refresh the KPI row. `competencyId` is
   * passed when that competency's versions changed, so a stale deep-link into the
   * Indicators tab can be dropped rather than left pointing at a superseded version.
   */
  onChanged?: (competencyId?: string) => void;
}

/** Competency library: searchable, category-filterable card grid with
 *  create/edit/archive. Category filter options are fetched, never hardcoded. */
export function CompetencyLibrary({ onViewIndicators, onChanged }: CompetencyLibraryProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Competency | null>(null);
  const [confirming, setConfirming] = useState<{ competency: Competency; draft: CompetencyVersion } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { has } = usePermissions();
  const { success, error: toastError } = useToast();
  const canManageVersions = has('competency.version.manage');

  const listParams = useMemo(
    () => ({ search, categoryId: categoryId || undefined, sortBy: 'name', sortOrder: 'asc' as const, page: 1, pageSize: 60 }),
    [search, categoryId],
  );
  const { data, loading, error, reload } = useCompetencies(listParams);
  const { data: categoryData } = useCategories(
    useMemo(() => ({ page: 1, pageSize: 100, sortBy: 'name', sortOrder: 'asc' as const }), []),
  );

  const competencies = data?.items ?? [];
  const categories = categoryData?.items ?? [];

  function openCreate(): void {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(competency: Competency): void {
    setEditing(competency);
    setDialogOpen(true);
  }

  function afterChange(competencyId?: string): void {
    reload();
    onChanged?.(competencyId);
  }

  async function handleArchive(competency: Competency): Promise<void> {
    await competencyApi.archiveCompetency(competency.id);
    afterChange(competency.id);
  }

  /**
   * Publish the pending draft. Confirmed first because the server retires the
   * previously-active version in the same transaction and a retired version can never
   * be reactivated — the only way back is another draft.
   */
  async function handleActivate(): Promise<void> {
    if (!confirming) return;
    const { competency, draft } = confirming;
    setBusyId(competency.id);
    try {
      await competencyApi.activateVersion(draft.id);
      success(`${competency.name} ${draft.versionLabel} is now active.`);
      setConfirming(null);
      afterChange(competency.id);
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : 'Could not activate this version.');
    } finally {
      setBusyId(null);
    }
  }

  /** Clone the latest version into a fresh draft — the only way to edit a published one. */
  async function handleNewVersion(competency: Competency): Promise<void> {
    setBusyId(competency.id);
    try {
      const draft = await competencyApi.cloneDraft(competency.id);
      success(`${draft.versionLabel} created as a draft. Edit its indicators, then activate it.`);
      afterChange(competency.id);
    } catch (err) {
      // The server refuses a second concurrent draft with a readable message.
      toastError(err instanceof ApiError ? err.message : 'Could not create a new version.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search competencies"
              className="pl-9"
            />
          </div>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="h-10 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={openCreate}>
          <Plus /> New competency
        </Button>
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-600/20">{error}</p>
      ) : null}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-52 w-full" />
          ))}
        </div>
      ) : competencies.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-12 text-center">
          <Layers className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No competencies found</p>
          <p className="text-sm text-muted-foreground">Adjust your filters or create a new competency.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {competencies.map((competency) => (
            <CompetencyCard
              key={competency.id}
              competency={competency}
              onEdit={openEdit}
              onViewIndicators={onViewIndicators}
              onArchive={handleArchive}
              onActivate={(c, draft) => setConfirming({ competency: c, draft })}
              onNewVersion={handleNewVersion}
              canManageVersions={canManageVersions}
              busy={busyId === competency.id}
            />
          ))}
        </div>
      )}

      <CompetencyFormDialog
        open={dialogOpen}
        competency={editing}
        categories={categories}
        onOpenChange={setDialogOpen}
        onSaved={afterChange}
      />

      <ActivateVersionDialog
        pending={confirming}
        busy={busyId !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
        onConfirm={handleActivate}
      />
    </div>
  );
}

/**
 * Activation is one-way, so it is confirmed rather than fired from the card. Names the
 * version being retired when there is one, because that is the consequence people miss.
 */
function ActivateVersionDialog({
  pending,
  busy,
  onOpenChange,
  onConfirm,
}: {
  pending: { competency: Competency; draft: CompetencyVersion } | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): JSX.Element {
  const retiring = pending?.competency.activeVersion ?? null;
  const draftLabel = pending ? pendingDraft(pending.competency)?.versionLabel ?? pending.draft.versionLabel : '';

  return (
    <Dialog open={Boolean(pending)} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Activate {draftLabel}?</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <p>
              <span className="font-medium">{pending?.competency.name}</span> {draftLabel} becomes the
              active version.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {retiring ? (
                <li>
                  {retiring.versionLabel} is retired. A retired version cannot be reactivated — you
                  would have to create another version.
                </li>
              ) : null}
              <li>Its behaviour indicators become read-only. Create a new version to change them.</li>
            </ul>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={onConfirm}>
              {busy ? 'Activating…' : 'Activate'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
