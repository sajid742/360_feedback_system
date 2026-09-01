import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Copy, Eye, EyeOff, LayoutTemplate, Plus, Save, Trash2 } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { HelpHint } from '@/components/ui/help-hint';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { appraisalApi, type Cycle, type CycleTemplate, type MyReview, type ReviewForm } from './api';
import { CycleDetail } from './CycleDetail';

const STATUS: Record<string, BadgeVariant> = { draft: 'warning', active: 'success', closed: 'neutral', archived: 'neutral' };

export function AppraisalPage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
          Appraisals
          <HelpHint title="What is an appraisal cycle?">
            A cycle defines who is reviewed, by which feedback sources (self, line manager, peers, subordinates, parents), over which dates. Create one, add sources and participants, assign or nominate reviewers, then activate it to collect feedback.
          </HelpHint>
        </h1>
        <p className="text-sm text-muted-foreground">360° cycles, reviewer assignment, feedback, and calibration.</p>
      </div>
      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="cycles">
          <TabsList>
            <TabsTrigger value="cycles">Cycles</TabsTrigger>
            <TabsTrigger value="reviews">My Reviews</TabsTrigger>
          </TabsList>
          <TabsContent value="cycles">
            <CyclesTab />
          </TabsContent>
          <TabsContent value="reviews">
            <MyReviewsTab />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}

function CyclesTab(): JSX.Element {
  const toast = useToast();
  const [cycles, setCycles] = useState<Cycle[] | null>(null);
  const [templates, setTemplates] = useState<CycleTemplate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [dates, setDates] = useState({ startDate: '', endDate: '' });
  const [templateId, setTemplateId] = useState('');
  const [saveFor, setSaveFor] = useState<Cycle | null>(null);

  const reload = useCallback(() => appraisalApi.listCycles().then(setCycles), []);
  const reloadTemplates = useCallback(() => appraisalApi.listCycleTemplates().then(setTemplates), []);
  useEffect(() => { void reload(); void reloadTemplates(); }, [reload, reloadTemplates]);

  async function create(): Promise<void> {
    if (!name.trim() || !dates.startDate || !dates.endDate) {
      toast.error('Enter a cycle name and start/end dates.');
      return;
    }
    try {
      const created = templateId
        ? await appraisalApi.applyCycleTemplate(templateId, { name: name.trim(), ...dates })
        : await appraisalApi.createCycle({ name: name.trim(), ...dates });
      setName('');
      setDates({ startDate: '', endDate: '' });
      const usedTemplate = templateId;
      setTemplateId('');
      await reload();
      toast.success(usedTemplate ? 'Cycle created from template — sources copied.' : 'Cycle created.');
      setSelected(created.id);
    } catch {
      toast.error('Could not create the cycle.');
    }
  }

  async function removeTemplate(t: CycleTemplate): Promise<void> {
    try {
      await appraisalApi.deleteCycleTemplate(t.id);
      await reloadTemplates();
      if (templateId === t.id) setTemplateId('');
      toast.success(`Template "${t.name}" deleted.`);
    } catch {
      toast.error('Could not delete the template.');
    }
  }

  if (selected) return <CycleDetail cycleId={selected} onBack={() => { setSelected(null); reload(); }} />;
  if (!cycles) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cycle name" className="max-w-xs" />
        <Input value={dates.startDate} onChange={(e) => setDates((d) => ({ ...d, startDate: e.target.value }))} type="date" className="max-w-[160px]" />
        <Input value={dates.endDate} onChange={(e) => setDates((d) => ({ ...d, endDate: e.target.value }))} type="date" className="max-w-[160px]" />
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          title="Start from a saved template (copies its sources, questionnaire and rating scale)"
          className="h-10 max-w-[200px] rounded-md border border-input bg-card px-2 text-sm"
        >
          <option value="">Blank cycle</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>From template: {t.name}</option>
          ))}
        </select>
        <Button onClick={create}>
          {templateId ? <><LayoutTemplate /> Create from template</> : <><Plus /> Create</>}
        </Button>
      </div>

      {templates.length > 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <LayoutTemplate className="size-3.5" /> Cycle templates ({templates.length})
          </p>
          <div className="grid gap-1.5">
            {templates.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-md bg-card px-3 py-1.5 text-sm">
                <span>
                  <span className="font-medium">{t.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{t.sources.length} source(s){t.description ? ` · ${t.description}` : ''}</span>
                </span>
                <Button size="sm" variant="ghost" className="text-red-600" title="Delete template" onClick={() => removeTemplate(t)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-2">
        {cycles.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-4 shadow-card transition-shadow hover:shadow-card-hover">
            <button onClick={() => setSelected(c.id)} className="flex-1 text-left">
              <p className="font-semibold">{c.name}</p>
              <p className="text-xs text-muted-foreground">{c.participants} participants · {c.sources} sources</p>
            </button>
            <div className="flex items-center gap-2">
              <Badge variant={STATUS[c.status] ?? 'neutral'}>{c.status}</Badge>
              <Button
                size="sm"
                variant="ghost"
                title="Save as reusable template"
                onClick={() => setSaveFor(c)}
              >
                <Save className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Duplicate cycle"
                onClick={async () => { const { id } = await appraisalApi.cloneCycle(c.id); await reload(); setSelected(id); }}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
        {cycles.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck />}
            title="No appraisal cycles yet"
            description="A cycle is one round of 360° feedback. Give it a name and start/end dates above — or start from a saved template — then add sources, participants and reviewers."
          />
        ) : null}
      </div>

      {saveFor ? (
        <SaveTemplateDialog
          cycle={saveFor}
          onClose={() => setSaveFor(null)}
          onSaved={async () => { setSaveFor(null); await reloadTemplates(); toast.success('Cycle saved as a reusable template.'); }}
          onError={() => toast.error('Could not save the template.')}
        />
      ) : null}
    </div>
  );
}

function SaveTemplateDialog({
  cycle,
  onClose,
  onSaved,
  onError,
}: {
  cycle: Cycle;
  onClose: () => void;
  onSaved: () => void;
  onError: () => void;
}): JSX.Element {
  const [name, setName] = useState(`${cycle.name} template`);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await appraisalApi.saveCycleTemplate({ name: name.trim(), description: description.trim() || undefined, fromCycleId: cycle.id });
      onSaved();
    } catch {
      onError();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <p className="mb-1 text-base font-bold">Save as reusable template</p>
        <p className="mb-4 text-xs text-muted-foreground">Captures the feedback sources, questionnaire and rating scale of “{cycle.name}” so you can start future cycles from it.</p>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <label className="text-xs font-medium">Template name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-1">
            <label className="text-xs font-medium">Description (optional)</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Standard annual 360 for academic staff" className="min-h-[70px]" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving}><Save className="size-3.5" /> {saving ? 'Saving…' : 'Save template'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "Head of Science · Academics" — whichever of the two the employee record has. */
function roleLine(title: string | null, department: string | null): string {
  return [title, department].filter(Boolean).join(' · ');
}

/**
 * Tells the reviewer what happens to THEIR name — the only thing the quadrant's
 * `isAnonymous` flag governs. The appraisee is always named; the evaluator is the
 * party a confidential quadrant protects.
 */
function AnonymityNote({ appraisee, anonymous, source, sourceCode }: { appraisee: string; anonymous: boolean; source: string; sourceCode: string }): JSX.Element {
  const firstName = appraisee.split(' ')[0];
  if (sourceCode === 'self') {
    return (
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Eye className="size-3 shrink-0" />
        This is your own self-assessment — it is always shown as yours.
      </p>
    );
  }
  return anonymous ? (
    <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
      <EyeOff className="size-3 shrink-0" />
      Your name is not shown to {firstName} — {source} feedback is reported as a group average only.
    </p>
  ) : (
    <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
      <Eye className="size-3 shrink-0" />
      Attributed feedback — {firstName} will see this came from their {source.toLowerCase()}.
    </p>
  );
}

function MyReviewsTab(): JSX.Element {
  const [reviews, setReviews] = useState<MyReview[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const reload = useCallback(() => appraisalApi.myReviews().then(setReviews), []);
  useEffect(() => void reload(), [reload]);

  if (active) return <ReviewFormView assignmentId={active} onDone={() => { setActive(null); reload(); }} />;
  if (!reviews) return <Skeleton className="h-40 w-full" />;
  if (reviews.length === 0) return <p className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">No pending reviews.</p>;
  return (
    <div className="grid gap-2">
      {reviews.map((r) => (
        <button key={r.id} onClick={() => setActive(r.id)} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 text-left hover:shadow-card-hover">
          <div className="min-w-0">
            <p className="font-semibold">{r.appraisee}</p>
            {roleLine(r.appraiseeTitle, r.appraiseeDepartment) ? (
              <p className="text-xs text-muted-foreground">{roleLine(r.appraiseeTitle, r.appraiseeDepartment)}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {r.cycle} · you are reviewing as {r.source}
              {r.deadline ? ` · due ${new Date(r.deadline).toLocaleDateString()}` : ''}
            </p>
            <AnonymityNote appraisee={r.appraisee} anonymous={r.anonymousToAppraisee} source={r.source} sourceCode={r.sourceCode} />
          </div>
          <Badge variant={r.status === 'in_progress' ? 'info' : 'warning'}>
            {r.status === 'in_progress' ? `Draft · ${r.answered} saved` : 'Not started'}
          </Badge>
        </button>
      ))}
    </div>
  );
}

function ReviewFormView({ assignmentId, onDone }: { assignmentId: string; onDone: () => void }): JSX.Element {
  const [form, setForm] = useState<ReviewForm | null>(null);
  const [answers, setAnswers] = useState<Record<string, { ratingValue?: number; textValue?: string }>>({});
  const [saving, setSaving] = useState<null | 'draft' | 'submit'>(null);
  const [savedNote, setSavedNote] = useState('');

  useEffect(() => {
    appraisalApi.reviewForm(assignmentId).then((f) => {
      setForm(f);
      // Seed the working answers with anything already saved so a resumed draft
      // keeps prior responses even for questions the reviewer doesn't re-touch.
      const seed: Record<string, { ratingValue?: number; textValue?: string }> = {};
      for (const q of f.questions) {
        if (q.ratingValue != null || q.textValue != null) {
          seed[q.id] = { ratingValue: q.ratingValue ?? undefined, textValue: q.textValue ?? undefined };
        }
      }
      setAnswers(seed);
    });
  }, [assignmentId]);

  if (!form) return <Skeleton className="h-64 w-full" />;

  const answeredCount = form.questions.filter((q) => answers[q.id]?.ratingValue != null || answers[q.id]?.textValue).length;
  const responsesFor = (): { questionId: string; ratingValue?: number; textValue?: string }[] =>
    form.questions.filter((q) => answers[q.id]).map((q) => ({ questionId: q.id, ...answers[q.id] }));

  async function saveDraft(): Promise<void> {
    setSaving('draft');
    try {
      const res = await appraisalApi.saveDraft(assignmentId, responsesFor());
      setSavedNote(`Draft saved · ${res.answered} answered`);
      setTimeout(() => setSavedNote(''), 3000);
    } finally {
      setSaving(null);
    }
  }

  async function submit(): Promise<void> {
    setSaving('submit');
    try {
      await appraisalApi.submit(assignmentId, form!.questions.map((q) => ({ questionId: q.id, ...answers[q.id] })));
      onDone();
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="grid gap-4">
      {/* Whose performance am I rating? Without this the questionnaire is unusable
          for anyone holding more than one review task. */}
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">You are reviewing</p>
        <p className="text-lg font-bold">{form.appraisee}</p>
        {roleLine(form.appraiseeTitle, form.appraiseeDepartment) ? (
          <p className="text-sm text-muted-foreground">{roleLine(form.appraiseeTitle, form.appraiseeDepartment)}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {form.cycle} · as {form.source}
          {form.deadline ? ` · due ${new Date(form.deadline).toLocaleDateString()}` : ''}
        </p>
        <AnonymityNote appraisee={form.appraisee} anonymous={form.anonymousToAppraisee} source={form.source} sourceCode={form.sourceCode} />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{answeredCount} of {form.questions.length} answered</p>
        {savedNote ? <span className="text-xs text-brand">{savedNote}</span> : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${form.questions.length ? (answeredCount / form.questions.length) * 100 : 0}%` }} />
      </div>
      <div className="grid gap-4">
        {form.questions.map((q) => (
          <div key={q.id} className="grid gap-2 rounded-lg border border-border bg-card p-3">
            <p className="text-sm font-medium">{q.text}</p>
            {q.type === 'text' ? (
              <Textarea
                defaultValue={q.textValue ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: { ...a[q.id], textValue: e.target.value } }))}
              />
            ) : (
              <>
                <Input
                  type="number"
                  placeholder="Rating"
                  defaultValue={q.ratingValue ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: { ...a[q.id], ratingValue: Number(e.target.value) } }))}
                />
                {form.scale.length > 0 ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {form.scale.map((lvl) => (
                      <span key={lvl.value}>
                        <span className="font-semibold" style={lvl.color ? { color: lvl.color } : undefined}>{lvl.value}</span> {lvl.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
        {form.questions.length === 0 ? <p className="text-sm text-muted-foreground">This cycle has no questionnaire template attached.</p> : null}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button variant="outline" onClick={saveDraft} disabled={saving !== null || form.questions.length === 0}>
          {saving === 'draft' ? 'Saving…' : 'Save draft'}
        </Button>
        <Button onClick={submit} disabled={saving !== null || form.questions.length === 0}>
          {saving === 'submit' ? 'Submitting…' : 'Submit feedback'}
        </Button>
      </div>
    </div>
  );
}
