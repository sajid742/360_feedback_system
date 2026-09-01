import { useMemo, useState } from 'react';
import { FolderTree, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { competencyApi } from '../api';
import { useCategories } from '../hooks';
import type { CompetencyCategory } from '../types';
import { CategoryFormDialog } from './CategoryFormDialog';

/**
 * Restyled category management panel (Session 3). Card-based rows with soft
 * badges for competency counts, inline search, and create/edit/delete. No
 * hardcoded categories — everything is fetched.
 */
export function CategoriesPanel(): JSX.Element {
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CompetencyCategory | null>(null);

  const params = useMemo(
    () => ({ search, sortBy: 'name', sortOrder: 'asc' as const, page: 1, pageSize: 100 }),
    [search],
  );
  const { data, loading, error, reload } = useCategories(params);
  const categories = data?.items ?? [];

  function openCreate(): void {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(category: CompetencyCategory): void {
    setEditing(category);
    setDialogOpen(true);
  }

  async function handleDelete(category: CompetencyCategory): Promise<void> {
    await competencyApi.deleteCategory(category.id);
    reload();
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search categories"
            className="pl-9"
          />
        </div>
        <Button onClick={openCreate}>
          <Plus /> New category
        </Button>
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-600/20">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3">
        {loading
          ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
          : categories.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
                onEdit={() => openEdit(category)}
                onDelete={() => handleDelete(category)}
              />
            ))}

        {!loading && categories.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-10 text-center">
            <FolderTree className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No categories yet</p>
            <p className="text-sm text-muted-foreground">Create a category to start organizing competencies.</p>
          </div>
        ) : null}
      </div>

      <CategoryFormDialog
        open={dialogOpen}
        category={editing}
        onOpenChange={setDialogOpen}
        onSaved={reload}
      />
    </div>
  );
}

interface CategoryRowProps {
  category: CompetencyCategory;
  onEdit: () => void;
  onDelete: () => void;
}

function CategoryRow({ category, onEdit, onDelete }: CategoryRowProps): JSX.Element {
  const countLabel = `${category.competencyCount} ${category.competencyCount === 1 ? 'competency' : 'competencies'}`;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 shadow-card transition-shadow hover:shadow-card-hover">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-brand">
          <FolderTree className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-semibold">{category.name}</p>
            <Badge variant="info">{countLabel}</Badge>
            {!category.isActive ? <Badge variant="neutral">Disabled</Badge> : null}
          </div>
          {category.description ? (
            <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{category.description}</p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Edit category" onClick={onEdit}>
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete category"
          className="text-red-600 hover:bg-red-50 hover:text-red-700"
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
