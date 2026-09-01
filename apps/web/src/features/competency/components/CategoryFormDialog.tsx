import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-client';
import { competencyApi } from '../api';
import type { CategoryInput, CompetencyCategory } from '../types';

interface CategoryFormDialogProps {
  open: boolean;
  category: CompetencyCategory | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** Create / edit a competency category. Validates name locally and surfaces
 *  server-side field errors from the API envelope. */
export function CategoryFormDialog({
  open,
  category,
  onOpenChange,
  onSaved,
}: CategoryFormDialogProps): JSX.Element {
  const [form, setForm] = useState<CategoryInput>({ name: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({ name: category?.name ?? '', description: category?.description ?? '' });
    setError(null);
  }, [category, open]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!form.name.trim()) {
      setError('Category name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (category) {
        await competencyApi.updateCategory(category.id, form);
      } else {
        await competencyApi.createCategory(form);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{category ? 'Edit category' : 'New category'}</DialogTitle>
            <DialogDescription>
              Group related competencies. Names must be unique within your organization.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="category-name">Name</Label>
            <Input
              id="category-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Leadership"
              autoFocus
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="category-description">Description</Label>
            <Textarea
              id="category-description"
              value={form.description ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What this category covers"
            />
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
