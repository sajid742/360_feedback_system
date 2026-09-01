import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, BellRing, Check, Eye, EyeOff, Lock, Pencil, Plus, Rocket, Send, Upload, UserPlus, X } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { orgApi, type Employee } from '@/features/organization/api';
import { questionnaireApi, type TemplateSummary } from '@/features/questionnaire/api';
import { appraisalApi, type Assignment, type Cycle, type CycleCoverage, type Participant, type Participation, type Source } from './api';

const STATUS_TONE: Record<string, BadgeVariant> = {
  draft: 'warning',
  active: 'success',
  closed: 'neutral',
  archived: 'neutral',
};

export function CycleDetail({ cycleId, onBack }: { cycleId: string; onBack: () => void }): JSX.Element {
  const toast = useToast();
  const [reminded, setReminded] = useState<number | null>(null);
  const [pendingNominations, setPendingNominations] = useState(0);
  const [busy, setBusy] = useState<'remind' | 'activate' | 'close' | null>(null);
  // The header offers Activate or Close depending on where the cycle is in its lifecycle,
  // so it has to know the status. The list endpoint is already the source for it.
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const loadCycle = useCallback(() => {
    appraisalApi
      .listCycles()
      .then((list) => setCycle(list.find((c) => c.id === cycleId) ?? null))
      .catch(() => undefined);
  }, [cycleId]);
  useEffect(() => loadCycle(), [loadCycle]);

  // These two actions previously gave no feedback at all — "Activate" in particular
  // was fire-and-forget, so an admin could not tell whether the cycle had started
  // or the call had failed (F-H2).
  const sendReminders = async (): Promise<void> => {
    setBusy('remind');
    try {
      const { sent } = await appraisalApi.remind(cycleId);
      setReminded(sent);
      toast.success(sent > 0 ? `${sent} reminder(s) sent.` : 'No outstanding reviewers to remind.');
      setTimeout(() => setReminded(null), 4000);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not send reminders.');
    } finally {
      setBusy(null);
    }
  };

  const activateCycle = async (): Promise<void> => {
    setBusy('activate');
    try {
      await appraisalApi.activate(cycleId);
      toast.success('Cycle activated — evaluators have been notified.');
      loadCycle();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not activate the cycle.');
    } finally {
      setBusy(null);
    }
  };

  // Closing ends collection and notifies participants. It is reversible — re-activating a
  // closed cycle is supported and recorded as "reopened" — but any feedback not submitted
  // by now stays unsubmitted, so it is confirmed rather than fired from the toolbar.
  const closeCycle = async (): Promise<void> => {
    setBusy('close');
    try {
      await appraisalApi.close(cycleId);
      toast.success('Cycle closed — no further feedback will be accepted.');
      setConfirmClose(false);
      loadCycle();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not close the cycle.');
    } finally {
      setBusy(null);
    }
  };

  const isActive = cycle?.status === 'active';
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> Cycles
        </Button>
        {cycle ? (
          <>
            <span className="text-sm font-medium">{cycle.name}</span>
            <Badge variant={STATUS_TONE[cycle.status] ?? 'neutral'}>{cycle.status}</Badge>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {reminded !== null ? <span className="text-xs text-muted-foreground">{reminded} reminder(s) sent</span> : null}
          <Button size="sm" variant="outline" onClick={sendReminders} disabled={busy !== null}>
            <BellRing /> {busy === 'remind' ? 'Sending…' : 'Send reminders'}
          </Button>
          {isActive ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmClose(true)} disabled={busy !== null}>
              <Lock /> Close cycle
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={activateCycle} disabled={busy !== null}>
              <Rocket /> {busy === 'activate' ? 'Activating…' : cycle && cycle.status !== 'draft' ? 'Reopen' : 'Activate'}
            </Button>
          )}
        </div>
      </div>

      <ConfirmCloseDialog
        open={confirmClose}
        cycleName={cycle?.name ?? 'this cycle'}
        busy={busy === 'close'}
        onOpenChange={setConfirmClose}
        onConfirm={closeCycle}
      />
      <Tabs defaultValue="sources">
        <TabsList>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="participants">Participants</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="nominations">
            Nominations{pendingNominations > 0 ? <Badge variant="info" className="ml-2">{pendingNominations}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="participation">Participation</TabsTrigger>
        </TabsList>
        <TabsContent value="sources">
          <SourcesTab cycleId={cycleId} />
        </TabsContent>
        <TabsContent value="participants">
          <ParticipantsTab cycleId={cycleId} />
        </TabsContent>
        <TabsContent value="assignments">
          <AssignmentsTab cycleId={cycleId} />
        </TabsContent>
        <TabsContent value="nominations">
          <NominationsTab cycleId={cycleId} onPendingChange={setPendingNominations} />
        </TabsContent>
        <TabsContent value="participation">
          <ParticipationTab cycleId={cycleId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SourcesTab({ cycleId }: { cycleId: string }): JSX.Element {
  const toast = useToast();
  const [items, setItems] = useState<Source[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  // Bumped after a questionnaire change so the coverage matrix below re-reads.
  const [coverageKey, setCoverageKey] = useState(0);
  const [form, setForm] = useState({ code: '', label: '', weight: '1' });
  const [editing, setEditing] = useState<Source | null>(null);
  const reload = useCallback(() => appraisalApi.listSources(cycleId).then(setItems), [cycleId]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    questionnaireApi.listTemplates().then(setTemplates);
  }, []);

  async function add(): Promise<void> {
    if (!form.code.trim() || !form.label.trim()) return;
    await appraisalApi.addSource(cycleId, { code: form.code.trim(), label: form.label.trim(), weight: Number(form.weight) || 1 });
    setForm({ code: '', label: '', weight: '1' });
    reload();
  }

  // A quadrant can ask its own set of questions (students rarely answer the same
  // form as peers). An empty choice clears it, so the quadrant follows the cycle
  // questionnaire again.
  async function chooseTemplate(source: Source, templateId: string): Promise<void> {
    setSavingId(source.id);
    try {
      await appraisalApi.setSourceTemplate(cycleId, source.id, templateId || null);
      await reload();
      setCoverageKey((k) => k + 1);
      toast.success(
        templateId ? `${source.label} now uses its own questionnaire.` : `${source.label} follows the cycle questionnaire again.`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not change the questionnaire for this quadrant.');
    } finally {
      setSavingId(null);
    }
  }

  if (!items) return <Skeleton className="h-32 w-full" />;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="code (e.g. peer)" className="max-w-[140px]" />
        <Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="Label" className="max-w-xs" />
        <Input value={form.weight} onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))} placeholder="weight" type="number" className="w-24" />
        <Button onClick={add}>
          <Plus /> Add
        </Button>
      </div>
      {/*
        Weights are RELATIVE, not percentages that must total 100. The share column is
        each weight over the sum of all of them — which is also why the share moves when
        a quadrant is added or its weight changes.
      */}
      <p className="text-xs text-muted-foreground">
        Weights are relative: a quadrant&rsquo;s influence is its weight divided by the total of all weights, shown as the share below.
        For multiple manager levels, add one quadrant per level (<code>manager</code>, <code>manager_l2</code>, <code>manager_l3</code>&hellip;) and give each its own weight.
      </p>
      {items.map((s) => (
        <div key={s.id} className="grid gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{s.label} <span className="text-muted-foreground">({s.code})</span></span>
            <div className="flex items-center gap-2">
              <Badge variant="brand">weight {s.weight} · {s.weightShare}%</Badge>
              <Button variant="ghost" size="sm" onClick={() => setEditing(s)} title="Change label, weight, required responses or anonymity">
                <Pencil className="size-4" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`questionnaire-${s.id}`} className="text-xs text-muted-foreground">Questionnaire</label>
            <select
              id={`questionnaire-${s.id}`}
              value={s.templateId ?? ''}
              disabled={savingId === s.id}
              onChange={(e) => chooseTemplate(s, e.target.value)}
              className="h-9 max-w-xs rounded-md border border-input bg-card px-2 text-sm"
            >
              <option value="">Cycle questionnaire (inherited)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {s.effectiveTemplateName ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Reviewers answer <span className="font-medium text-foreground">{s.effectiveTemplateName}</span>
                {s.inheritsCycleTemplate ? <Badge variant="neutral">inherited</Badge> : null}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No questionnaire yet — pick one here or set one on the cycle.</span>
            )}
          </div>
          {s.code === 'parent' ? <ParentModeRow cycleId={cycleId} source={s} onChanged={reload} /> : null}
        </div>
      ))}
      {items.length === 0 ? <p className="text-sm text-muted-foreground">No feedback sources configured.</p> : null}
      {editing ? (
        <SourceEditDialog
          cycleId={cycleId}
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      ) : null}
      <CoverageMatrix cycleId={cycleId} refreshKey={coverageKey} />
    </div>
  );
}

/**
 * Closing is confirmed rather than fired from the toolbar. It stops the cycle accepting
 * feedback and notifies participants, and any reviewer who has not submitted by then never
 * will — which is the consequence people miss.
 */
function ConfirmCloseDialog({
  open,
  cycleName,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  cycleName: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Close {cycleName}?</DialogTitle>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>No further feedback will be accepted. Reviewers who have not submitted never will, and their assignments stay outstanding.</li>
            <li>The roster is frozen — no new participants, assignments or bulk generation.</li>
            <li>Participants are notified that the cycle has closed.</li>
            <li>Scores already computed are unaffected, and results release is unchanged.</li>
          </ul>
          <p className="text-sm text-muted-foreground">
            This can be undone: re-activating a closed cycle reopens it, and the audit trail records that
            as <span className="font-medium text-foreground">reopened</span> rather than a fresh start.
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={onConfirm}>{busy ? 'Closing…' : 'Close cycle'}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How the Parents quadrant collects feedback.
 *
 * Standard is the original behaviour: one secure link per teacher, so a parent whose
 * child has five teachers receives five links. Consolidated issues one link per student
 * listing all of that child's teachers, with one rating each — a data-entry improvement
 * only. Each rating still lands on that teacher's own assignment, so scoring, the
 * quadrant weight, the anonymity threshold and every report work exactly as before, and
 * suppression is still evaluated per teacher.
 */
function ParentModeRow({ cycleId, source, onChanged }: { cycleId: string; source: Source; onChanged: () => void }): JSX.Element {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const consolidated = source.parentMode === 'consolidated';

  async function save(mode: 'standard' | 'consolidated', requireAll: boolean): Promise<void> {
    setSaving(true);
    try {
      await appraisalApi.setParentMode(cycleId, source.id, mode, requireAll);
      toast.success(
        mode === 'consolidated'
          ? 'Parents now receive one form per student, covering all of that child’s teachers.'
          : 'Parents now receive one form per teacher.',
      );
      onChanged();
    } catch (e) {
      // The server refuses consolidated mode unless the quadrant's questionnaire holds
      // exactly one rating question; that message is worth showing verbatim.
      toast.error(e instanceof ApiError ? e.message : 'Could not change the parent feedback mode.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`parent-mode-${source.id}`} className="text-xs text-muted-foreground">Parent feedback mode</label>
        <select
          id={`parent-mode-${source.id}`}
          value={consolidated ? 'consolidated' : 'standard'}
          disabled={saving}
          onChange={(e) => void save(e.target.value as 'standard' | 'consolidated', source.parentRequireAll)}
          className="h-9 max-w-xs rounded-md border border-input bg-card px-2 text-sm"
        >
          <option value="standard">Standard — one form per teacher</option>
          <option value="consolidated">Consolidated — one form per student</option>
        </select>
        {consolidated ? <Badge variant="brand">consolidated</Badge> : null}
      </div>
      {consolidated ? (
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={source.parentRequireAll}
            disabled={saving}
            onChange={(e) => void save('consolidated', e.target.checked)}
          />
          <span>
            Require a rating for every teacher listed.
            <span className="block">
              Off by default. A teacher the parent leaves unrated is recorded as <span className="font-medium text-foreground">not asked</span> —
              excluded from that teacher’s average and from their anonymity count — never as a low score.
            </span>
          </span>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">
          The consolidated form asks one question about each teacher, so the Parents questionnaire must hold exactly one
          rating question. Parents see the cycle’s rating scale.
        </p>
      )}
    </div>
  );
}

/**
 * Competency coverage matrix. Shows which competencies each quadrant's questionnaire
 * actually asks about, and therefore which competencies can be compared between
 * evaluator groups. Entirely derived from the questionnaires attached above, so it
 * follows any change made to them.
 */
function CoverageMatrix({ cycleId, refreshKey }: { cycleId: string; refreshKey: number }): JSX.Element {
  const [data, setData] = useState<CycleCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    appraisalApi
      .coverage(cycleId)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load competency coverage.'));
  }, [cycleId, refreshKey]);

  if (error) return <p className="mt-4 text-sm text-muted-foreground">{error}</p>;
  if (!data) return <Skeleton className="mt-4 h-40 w-full" />;

  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4">
      <div>
        <p className="text-sm font-semibold">Competency coverage</p>
        <p className="text-xs text-muted-foreground">
          A competency is shared when two or more quadrants ask about it, which is what makes their scores comparable.
          This is worked out from the questionnaires attached to each quadrant above — it is not a separate setting.
        </p>
      </div>

      {!data.mixedQuestionnaires ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Every quadrant uses the cycle questionnaire
          {data.cycleTemplateName ? <> (<span className="font-medium text-foreground">{data.cycleTemplateName}</span>)</> : null}
          , so all quadrants cover exactly the same competencies.
        </p>
      ) : null}

      {data.questionsWithoutCompetency > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {data.questionsWithoutCompetency} question(s) are not linked to any competency. Their answers still count towards
          the quadrant score, but they appear in no competency report.
        </p>
      ) : null}

      {data.competencies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No competencies are covered yet — attach a questionnaire to at least one quadrant.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Competency</th>
                {data.quadrants.map((q) => (
                  <th key={q.sourceId} className="p-3">
                    <div>{q.label}</div>
                    <div className="font-normal normal-case">{q.effectiveTemplateName ?? 'no questionnaire'}</div>
                  </th>
                ))}
                <th className="p-3">Comparable?</th>
              </tr>
            </thead>
            <tbody>
              {data.competencies.map((c) => (
                <tr key={c.competencyId} className="border-t border-border">
                  <td className="p-3 font-medium">{c.competency}</td>
                  {data.quadrants.map((q) => {
                    const count = c.questionCountByQuadrant[q.code] ?? 0;
                    return (
                      <td key={q.sourceId} className="p-3">
                        {count > 0 ? (
                          <span className="flex items-center gap-1 text-xs">
                            <Check className="size-3.5 text-emerald-600" />
                            {count} question{count === 1 ? '' : 's'}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="p-3">
                    <Badge variant={c.shared ? 'success' : 'neutral'}>{c.shared ? 'Shared' : 'Quadrant-specific'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ParticipantsTab({ cycleId }: { cycleId: string }): JSX.Element {
  const [items, setItems] = useState<Participant[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const reload = useCallback(() => appraisalApi.listParticipants(cycleId).then(setItems), [cycleId]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    orgApi.listEmployees('').then((r) => setEmployees(r.items));
  }, []);

  if (!items) return <Skeleton className="h-32 w-full" />;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) appraisalApi.addParticipant(cycleId, e.target.value).then(reload);
            e.target.value = '';
          }}
          className="h-10 max-w-sm rounded-md border border-input bg-card px-3 text-sm"
        >
          <option value="">+ Enroll employee…</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.user.fullName ?? e.user.email}
            </option>
          ))}
        </select>
        <BulkImport cycleId={cycleId} onDone={reload} />
      </div>
      {items.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <div>
            <span className="text-sm font-medium">{p.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">{p.assignments} reviewers</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={p.visibility === 'released' ? 'success' : 'neutral'}>
              {p.visibility === 'released' ? 'Released' : 'Held'}
            </Badge>
            <Badge variant={p.finalScore != null ? 'success' : 'neutral'}>
              {p.finalScore != null ? `Score ${p.finalScore}` : p.status}
            </Badge>
            {p.potentialRating != null ? <Badge variant="info">Potential {p.potentialRating}</Badge> : null}
            <ReleaseButton participant={p} cycleId={cycleId} onDone={reload} />
            <CalibrateInput participantId={p.id} onDone={reload} />
            <PotentialInput participantId={p.id} onDone={reload} />
          </div>
        </div>
      ))}
      {items.length === 0 ? <p className="text-sm text-muted-foreground">No participants enrolled.</p> : null}
    </div>
  );
}

function ReleaseButton({ participant, cycleId, onDone }: { participant: Participant; cycleId: string; onDone: () => void }): JSX.Element {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const released = participant.visibility === 'released';
  // Releasing results is a consequential, employee-visible action; it previously
  // reported neither success nor failure (F-H2).
  const toggle = async (): Promise<void> => {
    setSaving(true);
    try {
      if (released) await appraisalApi.retract(cycleId, participant.id);
      else await appraisalApi.release(cycleId, participant.id);
      toast.success(released ? `Results retracted for ${participant.name}.` : `Results released to ${participant.name}.`);
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not change the release status.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={toggle} disabled={saving} title={released ? 'Retract results' : 'Release results to employee'}>
      {released ? <><EyeOff className="mr-1 size-3.5" />Retract</> : <><Eye className="mr-1 size-3.5" />Release</>}
    </Button>
  );
}

function CalibrateInput({ participantId, onDone }: { participantId: string; onDone: () => void }): JSX.Element {
  const [value, setValue] = useState('');
  return (
    <div className="flex items-center gap-1">
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="calibrate" type="number" className="h-8 w-24" />
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (value) appraisalApi.calibrate(participantId, Number(value)).then(() => { setValue(''); onDone(); });
        }}
      >
        Set
      </Button>
    </div>
  );
}

function PotentialInput({ participantId, onDone }: { participantId: string; onDone: () => void }): JSX.Element {
  const [value, setValue] = useState('');
  return (
    <div className="flex items-center gap-1">
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="potential" type="number" className="h-8 w-24" />
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (value) appraisalApi.setPotential(participantId, Number(value)).then(() => { setValue(''); onDone(); });
        }}
      >
        Set
      </Button>
    </div>
  );
}

function AssignmentsTab({ cycleId }: { cycleId: string }): JSX.Element {
  const [items, setItems] = useState<Assignment[] | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [form, setForm] = useState({ participantId: '', sourceId: '', reviewerEmployeeId: '', propose: false });
  // A large cycle has thousands of assignments; fetch a page at a time (F-P5).
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const reload = useCallback(
    () =>
      appraisalApi.listAssignments(cycleId, { page, pageSize: 50 }).then((r) => {
        setItems(r.items);
        setTotal(r.total);
        setTotalPages(r.totalPages);
      }),
    [cycleId, page],
  );
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    appraisalApi.listParticipants(cycleId).then(setParticipants);
    appraisalApi.listSources(cycleId).then(setSources);
    orgApi.listEmployees('').then((r) => setEmployees(r.items));
  }, [cycleId]);

  async function add(): Promise<void> {
    if (!form.participantId || !form.sourceId || !form.reviewerEmployeeId) return;
    await appraisalApi.createAssignment(cycleId, form);
    setForm({ participantId: '', sourceId: '', reviewerEmployeeId: '', propose: false });
    reload();
  }

  async function decide(id: string, approve: boolean): Promise<void> {
    if (approve) await appraisalApi.approveNomination(id);
    else await appraisalApi.rejectNomination(id);
    reload();
  }

  if (!items) return <Skeleton className="h-32 w-full" />;
  return (
    <div className="grid gap-3">
      <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 sm:grid-cols-4">
        <Select value={form.participantId} onChange={(v) => setForm((f) => ({ ...f, participantId: v }))} placeholder="Appraisee" options={participants.map((p) => ({ value: p.id, label: p.name }))} />
        <Select value={form.sourceId} onChange={(v) => setForm((f) => ({ ...f, sourceId: v }))} placeholder="Source" options={sources.map((s) => ({ value: s.id, label: s.label }))} />
        <Select value={form.reviewerEmployeeId} onChange={(v) => setForm((f) => ({ ...f, reviewerEmployeeId: v }))} placeholder="Reviewer" options={employees.map((e) => ({ value: e.id, label: e.user.fullName ?? e.user.email }))} />
        <Button onClick={add}>
          <Plus /> {form.propose ? 'Nominate' : 'Assign'}
        </Button>
        <label className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-4">
          <input type="checkbox" checked={form.propose} onChange={(e) => setForm((f) => ({ ...f, propose: e.target.checked }))} />
          Add as a nomination (requires manager approval before the reviewer sees it)
        </label>
      </div>
      {items.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <span>
            <span className="font-medium">{a.reviewer}</span> reviews <span className="font-medium">{a.appraisee}</span> · {a.source}
          </span>
          <div className="flex items-center gap-2">
            {a.nominationStatus === 'proposed' ? (
              <>
                <Badge variant="info">nominated</Badge>
                <Button size="sm" variant="outline" onClick={() => decide(a.id, true)}><Check className="mr-1 size-3.5" />Approve</Button>
                <Button size="sm" variant="ghost" onClick={() => decide(a.id, false)}><X className="size-3.5" /></Button>
              </>
            ) : a.nominationStatus === 'rejected' ? (
              <Badge variant="danger">rejected</Badge>
            ) : (
              <Badge variant={a.status === 'submitted' ? 'success' : 'warning'}>{a.status}</Badge>
            )}
          </div>
        </div>
      ))}
      {items.length === 0 ? <p className="text-sm text-muted-foreground">No reviewer assignments yet.</p> : null}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{total} assignments · page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Guided reviewer-nomination flow (F3). Reuses the existing nomination endpoints
 * (create-with-propose + approve/reject). Gives managers/admins a focused queue to
 * nominate peers and review pending nominations, instead of hunting through the
 * full assignments list. `onPendingChange` surfaces the pending count as a tab badge.
 */
function NominationsTab({ cycleId, onPendingChange }: { cycleId: string; onPendingChange: (n: number) => void }): JSX.Element {
  const toast = useToast();
  const [items, setItems] = useState<Assignment[] | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [form, setForm] = useState({ participantId: '', sourceId: '', reviewerEmployeeId: '' });
  const [busy, setBusy] = useState<string | null>(null);

  // Ask the server only for what this screen shows (F-P5): the pending approval queue,
  // plus a short list of recent decisions. Previously it pulled EVERY assignment in the
  // cycle (thousands on a large one) just to filter a handful client-side.
  const [pending, setPending] = useState<Assignment[]>([]);
  const [decided, setDecided] = useState<Assignment[]>([]);

  const reload = useCallback(async () => {
    const [proposed, approved, rejected] = await Promise.all([
      appraisalApi.listAssignments(cycleId, { nominationStatus: 'proposed', pageSize: 100 }),
      appraisalApi.listAssignments(cycleId, { nominationStatus: 'approved', pageSize: 20 }),
      appraisalApi.listAssignments(cycleId, { nominationStatus: 'rejected', pageSize: 20 }),
    ]);
    setPending(proposed.items);
    setDecided([...approved.items, ...rejected.items]);
    setItems(proposed.items);
    onPendingChange(proposed.total);
  }, [cycleId, onPendingChange]);
  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    appraisalApi.listParticipants(cycleId).then(setParticipants);
    appraisalApi.listSources(cycleId).then(setSources);
    orgApi.listEmployees('').then((r) => setEmployees(r.items));
  }, [cycleId]);

  async function nominate(): Promise<void> {
    if (!form.participantId || !form.sourceId || !form.reviewerEmployeeId) {
      toast.error('Pick an appraisee, a source, and the reviewer to nominate.');
      return;
    }
    setBusy('nominate');
    try {
      await appraisalApi.createAssignment(cycleId, { ...form, propose: true });
      setForm({ participantId: '', sourceId: '', reviewerEmployeeId: '' });
      await reload();
      toast.success('Nomination submitted for approval.');
    } catch {
      toast.error('Could not submit nomination.');
    } finally {
      setBusy(null);
    }
  }

  async function decide(a: Assignment, approve: boolean): Promise<void> {
    setBusy(a.id);
    try {
      if (approve) await appraisalApi.approveNomination(a.id);
      else await appraisalApi.rejectNomination(a.id);
      await reload();
      toast.success(approve ? `Approved ${a.reviewer} to review ${a.appraisee}.` : `Rejected nomination of ${a.reviewer}.`);
    } catch {
      toast.error('Could not update the nomination.');
    } finally {
      setBusy(null);
    }
  }

  if (!items) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <p className="text-sm font-semibold">Nominate a reviewer</p>
        <p className="text-xs text-muted-foreground">
          Propose a peer, manager, or subordinate to give feedback. Nominations stay hidden from the reviewer until an approver accepts them below.
        </p>
        <div className="grid gap-2 sm:grid-cols-4">
          <Select value={form.participantId} onChange={(v) => setForm((f) => ({ ...f, participantId: v }))} placeholder="Appraisee" options={participants.map((p) => ({ value: p.id, label: p.name }))} />
          <Select value={form.sourceId} onChange={(v) => setForm((f) => ({ ...f, sourceId: v }))} placeholder="Source" options={sources.map((s) => ({ value: s.id, label: s.label }))} />
          <Select value={form.reviewerEmployeeId} onChange={(v) => setForm((f) => ({ ...f, reviewerEmployeeId: v }))} placeholder="Reviewer to nominate" options={employees.map((e) => ({ value: e.id, label: e.user.fullName ?? e.user.email }))} />
          <Button onClick={nominate} disabled={busy === 'nominate'}>
            <UserPlus /> {busy === 'nominate' ? 'Submitting…' : 'Nominate'}
          </Button>
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold">Pending approval ({pending.length})</p>
        {pending.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">No nominations waiting for review.</p>
        ) : (
          <div className="grid gap-2">
            {pending.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{a.reviewer}</span> nominated to review <span className="font-medium">{a.appraisee}</span> · {a.source}
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => decide(a, true)}><Check className="mr-1 size-3.5" />Approve</Button>
                  <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => decide(a, false)}><X className="mr-1 size-3.5" />Reject</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {decided.length > 0 ? (
        <div>
          <p className="mb-2 text-sm font-semibold text-muted-foreground">Recently decided</p>
          <div className="grid gap-2">
            {decided.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{a.reviewer}</span> → {a.appraisee} · {a.source}
                </span>
                <Badge variant={a.nominationStatus === 'approved' ? 'success' : 'danger'}>{a.nominationStatus}</Badge>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BulkImport({ cycleId, onDone }: { cycleId: string; onDone: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ added: number; skipped: number; notFound: string[] } | null>(null);

  const run = async (): Promise<void> => {
    const emails = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (emails.length === 0) return;
    const res = await appraisalApi.importParticipants(cycleId, emails);
    setResult(res);
    onDone();
  };

  if (!open) return <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Upload className="mr-1 size-3.5" />Bulk import</Button>;
  return (
    <div className="w-full rounded-lg border border-border bg-card p-3">
      <p className="mb-1 text-xs font-medium">Paste employee emails (comma, space, or newline separated)</p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="first.reviewer@example.com, second.reviewer@example.com" className="min-h-[80px]" />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={run}>Import</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setResult(null); setText(''); }}>Close</Button>
        {result ? (
          <span className="text-xs text-muted-foreground">
            {result.added} added · {result.skipped} already enrolled{result.notFound.length ? ` · ${result.notFound.length} not found` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ParticipationTab({ cycleId }: { cycleId: string }): JSX.Element {
  const [data, setData] = useState<Participation | null>(null);
  const reload = useCallback(() => appraisalApi.participation(cycleId).then(setData), [cycleId]);
  useEffect(() => void reload(), [reload]);

  const nudge = async (assignmentId: string): Promise<void> => {
    await appraisalApi.remindAssignment(assignmentId);
    reload();
  };

  if (!data) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Overall completion</span>
          <span className="text-sm text-muted-foreground">{data.submitted} / {data.total} · {data.completionPct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-brand" style={{ width: `${data.completionPct}%` }} />
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {data.bySource.map((s) => (
            <div key={s.source} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
              <span>{s.source}</span>
              <span className="text-muted-foreground">{s.submitted}/{s.total} · {s.completionPct}%</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold">Outstanding reviewers ({data.pendingTotal})</p>
        {data.pending.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">Everyone has submitted. 🎉</p>
        ) : (
          <div className="grid gap-2">
            {data.pending.map((p) => (
              <div key={p.assignmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{p.reviewer}</span> → {p.appraisee} · {p.source}
                  {p.lastRemindedAt ? <span className="ml-2 text-xs text-muted-foreground">reminded {new Date(p.lastRemindedAt).toLocaleDateString()}</span> : null}
                </span>
                <Button size="sm" variant="outline" onClick={() => nudge(p.assignmentId)}><Send className="mr-1 size-3.5" />Nudge</Button>
              </div>
            ))}
            {data.pendingTotal > data.pending.length ? (
              <p className="px-1 text-xs text-muted-foreground">
                Showing the {data.pending.length} longest-outstanding of {data.pendingTotal}. Send a bulk reminder from the cycle actions to reach everyone.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Select({ value, onChange, placeholder, options }: { value: string; onChange: (v: string) => void; placeholder: string; options: { value: string; label: string }[] }): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-10 rounded-md border border-input bg-card px-2 text-sm">
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Edit a quadrant after it exists.
 *
 * Until this dialog the only way to change a weight was to delete the quadrant and
 * re-add it — impossible once reviewers were assigned to it. `code` stays read-only:
 * assignments, the coverage matrix and the bulk generator all resolve a quadrant by
 * its code, so renaming one under them would orphan those references.
 */
function SourceEditDialog({ cycleId, source, onClose, onSaved }: {
  cycleId: string; source: Source; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const toast = useToast();
  const [form, setForm] = useState({
    label: source.label,
    weight: String(source.weight),
    requiredCount: String(source.requiredCount),
    isAnonymous: source.isAnonymous,
  });
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await appraisalApi.updateSource(cycleId, source.id, {
        label: form.label.trim(),
        weight: Number(form.weight),
        requiredCount: Number(form.requiredCount) || 1,
        isAnonymous: form.isAnonymous,
      });
      toast.success('Quadrant updated.');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not update the quadrant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Edit {source.label}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label className="text-xs">Code</Label>
            <Input value={source.code} disabled />
            <p className="text-xs text-muted-foreground">Not editable — assignments and reports resolve this quadrant by its code.</p>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Label</Label>
            <Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            <p className="text-xs text-muted-foreground">Must be unique in this cycle — reports group each quadrant&rsquo;s figures by label.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label className="text-xs">Weight</Label>
              <Input type="number" min="0" step="0.5" value={form.weight} onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))} />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">Required responses</Label>
              <Input type="number" min="1" value={form.requiredCount} onChange={(e) => setForm((f) => ({ ...f, requiredCount: e.target.value }))} />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.isAnonymous}
              onChange={(e) => setForm((f) => ({ ...f, isAnonymous: e.target.checked }))}
            />
            <span>
              Anonymous quadrant
              <span className="block text-xs text-muted-foreground">
                Anonymous quadrants are hidden in reports until enough people have replied. Attributed quadrants
                (Self, Line Manager and any further manager levels) are shown as soon as they have a score.
              </span>
            </span>
          </label>
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            Changing a weight re-scores every participant in this cycle the next time their feedback is recalculated.
            Scores already calibrated by hand are not affected.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || !form.label.trim()}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
