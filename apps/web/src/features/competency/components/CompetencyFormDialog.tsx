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
import type { Competency, CompetencyCategory, CompetencyInput } from '../types';

interface CompetencyFormDialogProps {
  open: boolean;
  competency: Competency | null;
  categories: CompetencyCategory[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

/** Create / edit a competency. Category options are supplied by the parent
 *  (already fetched) so this dialog does no data loading of its own. A new
 *  competency auto-creates its v1 draft server-side. */
export function CompetencyFormDialog({
  open,
  competency,
  categories,
  onOpenChange,
  onSaved,
}: CompetencyFormDialogProps): JSX.Element {
  const [form, setForm] = useState<CompetencyInput>({ categoryId: '', name: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({
      categoryId: competency?.categoryId ?? categories[0]?.id ?? '',
      name: competency?.name ?? '',
      description: competency?.description ?? '',
    });
    setError(null);
  }, [competency, categories, open]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!form.name.trim() || !form.categoryId) {
      setError('Name and category are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (competency) {
        await competencyApi.updateCompetency(competency.id, form);
      } else {
        await competencyApi.createCompetency(form);
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
            <DialogTitle>{competency ? 'Edit competency' : 'New competency'}</DialogTitle>
            <DialogDescription>
              {competency
                ? 'Update the competency details.'
                : 'A first draft version is created automatically for you to add behaviour indicators.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="competency-category">Category</Label>
            <select
              id="competency-category"
              value={form.categoryId}
              onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
              className="h-10 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="" disabled>
                Select a category
              </option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="competency-name">Name</Label>
            <Input
              id="competency-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Strategic Leadership"
              autoFocus
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="competency-description">Description</Label>
            <Textarea
              id="competency-description"
              value={form.description ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What this competency measures"
            />
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save competency'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
