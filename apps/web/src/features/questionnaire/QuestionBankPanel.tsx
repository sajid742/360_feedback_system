import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api-client';
import { competencyApi } from '@/features/competency/api';
import type { Competency } from '@/features/competency/types';
import { questionnaireApi, type Question, type QuestionType } from './api';

const TYPES: QuestionType[] = ['rating', 'yes_no', 'multiple_choice', 'text', 'numeric'];
/** Only a scored answer can contribute to a competency score. */
const SCORED_TYPES: QuestionType[] = ['rating', 'yes_no', 'numeric'];

const SELECT_CLASS =
  'h-10 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function QuestionBankPanel(): JSX.Element {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Question[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Question | null>(null);
  const [competencies, setCompetencies] = useState<Competency[]>([]);

  const reload = useCallback(() => {
    questionnaireApi.listQuestions(search).then((r) => setItems(r.items));
  }, [search]);
  useEffect(() => reload(), [reload]);

  // The competency list drives the picker and lets the rows show a name rather than a
  // UUID — the question payload carries `competencyId` only.
  useEffect(() => {
    competencyApi
      .listCompetencies({ page: 1, pageSize: 200, sortBy: 'name', sortOrder: 'asc' })
      .then((r) => setCompetencies(r.items))
      .catch(() => undefined);
  }, []);

  const nameOf = useMemo(() => {
    const byId = new Map(competencies.map((c) => [c.id, c.name]));
    return (id: string | null): string | null => (id ? byId.get(id) ?? 'Unknown competency' : null);
  }, [competencies]);

  const unlinked = (items ?? []).filter((q) => SCORED_TYPES.includes(q.type) && !q.competencyId).length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search questions" className="pl-9" />
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus /> New question
        </Button>
      </div>

      {unlinked > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {unlinked} scored question{unlinked === 1 ? ' is' : 's are'} not linked to a competency. Their answers still
          count towards the quadrant score, but they appear in no competency report — no coverage row, no heatmap cell
          and no gap analysis. Use <b>Edit</b> to set the competency.
        </p>
      ) : null}

      {!items ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="grid gap-2">
          {items.map((q) => {
            const competency = nameOf(q.competencyId);
            const needsCompetency = SCORED_TYPES.includes(q.type) && !q.competencyId;
            return (
              <div key={q.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{q.text}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant="info">{q.type}</Badge>
                    {competency ? <Badge variant="success">{competency}</Badge> : null}
                    {needsCompetency ? <Badge variant="warning">No competency</Badge> : null}
                    {q.category ? <Badge variant="neutral">{q.category}</Badge> : null}
                    {q.isMandatory ? <Badge variant="brand">Mandatory</Badge> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => setEditing(q)}
                    aria-label="Edit"
                    title="Edit question"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    onClick={() => questionnaireApi.deleteQuestion(q.id).then(reload)}
                    aria-label="Delete"
                    title="Delete question"
                    className="text-muted-foreground hover:text-red-600"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
            );
          })}
          {items.length === 0 ? <p className="text-sm text-muted-foreground">No questions yet.</p> : null}
        </div>
      )}

      <QuestionDialog
        mode="create"
        open={open}
        competencies={competencies}
        onOpenChange={setOpen}
        onSaved={reload}
      />
      <QuestionDialog
        mode="edit"
        open={Boolean(editing)}
        question={editing}
        competencies={competencies}
        onOpenChange={(next) => { if (!next) setEditing(null); }}
        onSaved={reload}
      />
    </div>
  );
}

/**
 * Create or edit a question.
 *
 * The competency picker is the important field. A question is what carries a competency
 * into a feedback cycle: the quadrant points at a questionnaire, the questionnaire holds
 * questions, and a question's competency link is what turns answers into a competency
 * score. Until this control existed the link could only be set through the API, so a
 * questionnaire authored here produced questions that scored but appeared in no
 * competency report.
 */
function QuestionDialog({
  mode,
  open,
  question,
  competencies,
  onOpenChange,
  onSaved,
}: {
  mode: 'create' | 'edit';
  open: boolean;
  question?: Question | null;
  competencies: Competency[];
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}): JSX.Element {
  const EMPTY = { text: '', type: 'rating' as QuestionType, category: '', competencyId: '' };
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      mode === 'edit' && question
        ? {
            text: question.text,
            type: question.type,
            category: question.category ?? '',
            competencyId: question.competencyId ?? '',
          }
        : EMPTY,
    );
    // `question` identity is the trigger for the edit dialog; EMPTY is a fresh literal each
    // render and must not be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, question]);

  const scored = SCORED_TYPES.includes(form.type);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!form.text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (mode === 'edit' && question) {
        // Empty means "no competency" and must travel as null — the server reads
        // undefined as "leave it as it was", so undefined could never clear the link.
        await questionnaireApi.updateQuestion(question.id, {
          text: form.text.trim(),
          type: form.type,
          category: form.category || undefined,
          competencyId: form.competencyId || null,
        });
      } else {
        await questionnaireApi.createQuestion({
          text: form.text.trim(),
          type: form.type,
          category: form.category || undefined,
          competencyId: form.competencyId || undefined,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this question.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{mode === 'edit' ? 'Edit question' : 'New question'}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="qtext">Question</Label>
            <Textarea id="qtext" value={form.text} onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))} autoFocus />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="qtype">Type</Label>
            <select
              id="qtype"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as QuestionType }))}
              className={SELECT_CLASS}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="qcomp">Competency</Label>
            <select
              id="qcomp"
              value={form.competencyId}
              onChange={(e) => setForm((f) => ({ ...f, competencyId: e.target.value }))}
              className={SELECT_CLASS}
            >
              <option value="">— None —</option>
              {competencies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.categoryName ? ` · ${c.categoryName}` : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {scored
                ? 'What this question measures. Answers roll up into this competency’s score, its row in the coverage matrix and its heatmap cell. Leave it empty and the answer still counts towards the quadrant score, but appears in no competency report.'
                : 'Free-text answers are never scored, so a competency link has no effect on this question type.'}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="qcat">Category</Label>
            <Input id="qcat" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="optional" />
            <p className="text-xs text-muted-foreground">
              A free-text grouping label for the question bank. Unrelated to the competency above, and it never
              affects scoring — the one exception is <code>eNPS</code>, which marks a question as the engagement score.
            </p>
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
