import { useCallback, useEffect, useMemo, useState } from 'react';
import { Send, Link2, Ban, RefreshCw, Copy, Users } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api-client';
import { TeacherMappingPanel } from './TeacherMappingPanel';
import {
  evalAdminApi,
  sisApi,
  type EvaluationLink,
  type SisParent,
  type SisStudent,
  type SisTeacherOfStudent,
} from './api';

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  completed: 'success',
  opened: 'info',
  sent: 'info',
  pending: 'neutral',
  revoked: 'danger',
  expired: 'warning',
};

const selectClass =
  'h-10 rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function SisEvaluationPage(): JSX.Element {
  const [students, setStudents] = useState<SisStudent[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SisStudent | null>(null);

  useEffect(() => {
    sisApi.students().then(setStudents).catch(() => setStudents([]));
  }, []);

  const filtered = useMemo(() => {
    if (!students) return [];
    const q = search.trim().toLowerCase();
    if (!q) return students.slice(0, 50);
    return students.filter((s) => s.name.toLowerCase().includes(q) || s.registrationNo.toLowerCase().includes(q)).slice(0, 50);
  }, [students, search]);

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">SIS · Parent Evaluations</h1>
        <p className="text-sm text-muted-foreground">
          Generate secure, no-login evaluation links for parents to evaluate a teacher for a specific subject, delivered
          over WhatsApp or Email. Parent feedback flows into the mapped employee's 360 cycle as a "Parents" source.
        </p>
      </div>

      <Tabs defaultValue="generate">
        <TabsList>
          <TabsTrigger value="generate">Generate &amp; Track</TabsTrigger>
          <TabsTrigger value="mapping">Teacher Mapping</TabsTrigger>
        </TabsList>
        <TabsContent value="mapping">
          <TeacherMappingPanel />
        </TabsContent>
        <TabsContent value="generate">
          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="p-4">
          <Label htmlFor="stu-search">Find a student</Label>
          <Input id="stu-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or registration no." className="mt-2" />
          <div className="mt-3 grid max-h-[28rem] gap-1 overflow-auto">
            {!students ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              filtered.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelected(s)}
                  className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                    selected?.id === s.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
                  }`}
                >
                  <p className="font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.registrationNo}
                    {s.currentClass ? ` · ${s.currentClass}${s.currentSection ? `-${s.currentSection}` : ''}` : ''}
                  </p>
                </button>
              ))
            )}
            {students && filtered.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">No students match.</p> : null}
          </div>
        </Card>

            {selected ? <StudentPanel student={selected} /> : (
              <Card className="grid place-items-center p-10 text-sm text-muted-foreground">Select a student to begin.</Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StudentPanel({ student }: { student: SisStudent }): JSX.Element {
  const [parents, setParents] = useState<SisParent[] | null>(null);
  const [teachers, setTeachers] = useState<SisTeacherOfStudent[] | null>(null);
  const [links, setLinks] = useState<EvaluationLink[] | null>(null);
  const [parentId, setParentId] = useState<string>('');
  const [channel, setChannel] = useState<'whatsapp' | 'email' | 'sms'>('whatsapp');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; url?: string } | null>(null);
  /** Link id armed for a destructive re-issue — see `regenerate`. */
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which parent feedback mode the target cycle is configured for. Drives whether this
  // panel offers one link per teacher or one consolidated link for the whole student.
  const [mode, setMode] = useState<string | null>(null);

  const reloadLinks = useCallback(() => {
    evalAdminApi.list(student.id).then(setLinks).catch(() => setLinks([]));
  }, [student.id]);

  /**
   * Re-read this student's guardians and teachers from the roster.
   *
   * Split out of the mount effect so it can be called again: the panel used to load
   * the contact details once per selected student and never again, so a guardian's
   * phone or e-mail corrected on Student Integration → Students & Parents kept showing
   * the old value here until the student was deselected and picked again.
   */
  const reloadRoster = useCallback(() => {
    setError(null);
    sisApi.parents(student.id).then((p) => {
      setParents(p);
      setParentId((current) => (current && p.some((x) => x.id === current) ? current : p[0]?.id ?? ''));
    }).catch(() => setParents([]));
    sisApi.teachers(student.id).then(setTeachers).catch(() => setTeachers([]));
  }, [student.id]);

  useEffect(() => {
    setParents(null);
    setTeachers(null);
    setParentId('');
    setNotice(null);
    setError(null);
    reloadRoster();
    evalAdminApi.parentMode().then((m) => setMode(m.mode)).catch(() => setMode(null));
    reloadLinks();
  }, [student.id, reloadRoster, reloadLinks]);

  /** One link for this student covering every teacher, when the cycle is set to consolidated mode. */
  async function generateConsolidated(send: boolean): Promise<void> {
    setBusy('consolidated');
    setError(null);
    setNotice(null);
    try {
      const link = await evalAdminApi.createConsolidated({
        studentId: student.id,
        parentId: parentId || undefined,
        send,
        channel: send ? channel : undefined,
      });
      const skipped = link.skipped?.length
        ? ` ${link.skipped.length} teacher(s) skipped: ${link.skipped.map((x) => `${x.teacher} (${x.reason})`).join(', ')}.`
        : '';
      setNotice({
        text: send
          ? `One form covering ${link.teachers.length} teacher(s) sent to the parent.${skipped}`
          : `One form covering ${link.teachers.length} teacher(s) created.${skipped}`,
        url: link.url,
      });
      reloadLinks();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not generate the consolidated form.');
    } finally {
      setBusy(null);
    }
  }

  async function generate(t: SisTeacherOfStudent, send: boolean): Promise<void> {
    setBusy(t.teachingAssignmentId + (send ? ':send' : ':gen'));
    setError(null);
    setNotice(null);
    try {
      const link = await evalAdminApi.create({
        studentId: student.id,
        teachingAssignmentId: t.teachingAssignmentId,
        parentId: parentId || undefined,
        send,
        channel,
      });
      setNotice({
        text: send
          ? `Link for ${t.teacher} (${t.subject}) sent via ${link.sent?.channel ?? channel}${link.sent?.recipient ? ` to ${link.sent.recipient}` : ''}.`
          : `Link for ${t.teacher} (${t.subject}) generated.`,
        url: link.url,
      });
      reloadLinks();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate the link.');
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string): Promise<void> {
    setBusy(id);
    try {
      await evalAdminApi.revoke(id);
      reloadLinks();
    } finally {
      setBusy(null);
    }
  }

  /**
   * Re-issuing a link the parent has ALREADY submitted discards their responses and
   * score, so the API refuses it unless `force` is sent. Rather than surfacing that as
   * a dead-end error, the first click arms the row and the second confirms — the same
   * two-click pattern the SIS sync uses for a destructive run.
   */
  async function regenerate(id: string): Promise<void> {
    const force = confirmDiscard === id;
    setBusy(id);
    setError(null);
    try {
      const link = await evalAdminApi.regenerate(id, { channel, force: force || undefined });
      setConfirmDiscard(null);
      setNotice({ text: `New link issued and re-sent via ${link.sent?.channel ?? channel}.`, url: link.url });
      reloadLinks();
    } catch (err) {
      if (err instanceof ApiError && /already been submitted/i.test(err.message)) {
        setConfirmDiscard(id);
        setError('This parent has already submitted. Re-issuing permanently discards their responses and score. Click "Discard & resend" to confirm, or leave it alone to keep the feedback.');
      } else {
        setConfirmDiscard(null);
        setError(err instanceof ApiError ? err.message : 'Could not regenerate.');
      }
    } finally {
      setBusy(null);
    }
  }

  const selectedParent = parents?.find((p) => p.id === parentId);

  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">{student.name}</h2>
            <p className="text-xs text-muted-foreground">
              {student.registrationNo}
              {student.currentClass ? ` · ${student.currentClass}${student.currentSection ? `-${student.currentSection}` : ''}` : ''}
              {student.program ? ` · ${student.program}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <Label className="text-xs">Parent / guardian</Label>
              {!parents ? (
                <Skeleton className="h-10 w-48" />
              ) : (
                <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={selectClass}>
                  {parents.length === 0 ? <option value="">No parents on record</option> : null}
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.relationship})
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">Channel</Label>
              <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className={selectClass}>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </select>
            </div>
          </div>
        </div>
        {selectedParent ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              Sends to:{' '}
              <span className="font-medium text-foreground">
                {channel === 'email'
                  ? selectedParent.email ?? '— no email on record —'
                  : selectedParent.whatsapp ?? selectedParent.mobile ?? '— no number on record —'}
              </span>
            </span>
            <button
              type="button"
              onClick={reloadRoster}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-muted"
              title="Re-read this guardian's contact details from the roster — use after correcting them on Student Integration → Students & Parents"
            >
              <RefreshCw className="size-3" /> Refresh
            </button>
          </p>
        ) : null}
        {notice ? (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <p>{notice.text}</p>
            {notice.url ? (
              <div className="mt-1 flex items-center gap-2">
                <code className="truncate rounded bg-white px-2 py-1 text-xs">{notice.url}</code>
                <button onClick={() => navigator.clipboard?.writeText(notice.url ?? '')} className="text-emerald-700 hover:text-emerald-900" title="Copy link">
                  <Copy className="size-4" />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      </Card>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Teachers & subjects</h3>
        {mode === 'consolidated' ? (
          <div className="mb-3 grid gap-2 rounded-lg border border-brand/30 bg-brand/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Users className="size-4 text-brand" />
              <span className="text-sm font-medium">Consolidated parent form</span>
              <Badge variant="brand">one form per student</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              This cycle&rsquo;s Parents quadrant is set to the consolidated form, so {student.name}&rsquo;s parent
              receives <b>one</b> link covering every teacher below &mdash; not one link each. Each rating is still
              recorded against that teacher individually.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => generateConsolidated(false)}>
                <Link2 /> Generate one form
              </Button>
              <Button size="sm" disabled={busy !== null || !parentId} onClick={() => generateConsolidated(true)}>
                <Send /> Generate &amp; send
              </Button>
            </div>
          </div>
        ) : null}

        {!teachers ? (
          <Skeleton className="h-32 w-full" />
        ) : teachers.length === 0 ? (
          <p className="text-sm text-muted-foreground">This student has no teaching assignments in the SIS.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Teacher</th>
                  <th className="p-3">Subject</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {teachers.map((t) => (
                  <tr key={t.teachingAssignmentId} className="border-t border-border">
                    <td className="p-3 font-medium">{t.teacher}</td>
                    <td className="p-3">{t.subject}{t.section ? <span className="text-muted-foreground"> · {t.section}</span> : null}</td>
                    <td className="p-3">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => generate(t, false)}>
                          <Link2 /> Generate
                        </Button>
                        <Button size="sm" disabled={busy !== null || !parentId} onClick={() => generate(t, true)}>
                          <Send /> Generate &amp; send
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Evaluation links</h3>
        {!links ? (
          <Skeleton className="h-24 w-full" />
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground">No links generated yet for this student.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Parent</th>
                  <th className="p-3">Sent to</th>
                  <th className="p-3">Evaluating</th>
                  <th className="p-3">Type</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Score</th>
                  <th className="p-3">Sent</th>
                  <th className="p-3">Completed</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => {
                  // The guardian on the roster TODAY, matched by the id stored on the
                  // link. It is shown only to give the relationship and to say when the
                  // roster has since changed — the row itself still displays the name and
                  // recipient recorded when the link was generated.
                  const current = parents?.find((p) => p.id === l.parentId);
                  const drifted = !!current && !!l.parent && current.name !== l.parent;
                  // The recipient is frozen on the link when it is generated. If the
                  // guardian's contact has been corrected since, the row would otherwise
                  // just look wrong — so say which value is which rather than leaving the
                  // reader to guess whether the roster or the link is out of date.
                  const currentTo = current?.whatsapp ?? current?.mobile ?? current?.email ?? null;
                  const toDrifted = !!currentTo && !!l.recipient && currentTo !== l.recipient;
                  return (
                  <tr key={l.id} className="border-t border-border">
                    <td className="p-3">
                      <p className="font-medium">{l.parent ?? '—'}</p>
                      <p className="text-xs text-muted-foreground">
                        {l.parentId ?? '—'}{current ? ` · ${current.relationship}` : ''}
                      </p>
                      {drifted && (
                        <p className="text-xs text-amber-600" title="The guardian record has been corrected since this link was generated. The link keeps what was true at the time.">
                          roster now: {current!.name}
                        </p>
                      )}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {l.recipient ?? '—'}
                      {toDrifted && (
                        <span className="block text-amber-600" title="This link was sent to the contact recorded at the time. The roster has been corrected since; new links will use the current value.">
                          roster now: {currentTo}
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      <p className="font-medium">{l.teacher ?? (l.mode === 'consolidated' ? 'All teachers' : '—')}</p>
                      <p className="text-xs text-muted-foreground">{l.subject ?? (l.mode === 'consolidated' ? 'one form, every teacher' : '')}</p>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{l.mode === 'consolidated' ? 'Consolidated' : 'Per teacher'}</td>
                    <td className="p-3"><Badge variant={STATUS_VARIANT[l.status] ?? 'neutral'}>{l.status}</Badge></td>
                    <td className="p-3">{l.overallScore ?? '—'}</td>
                    <td className="p-3 text-xs text-muted-foreground">{l.sentAt ? new Date(l.sentAt).toLocaleDateString() : '—'}</td>
                    <td className="p-3 text-xs text-muted-foreground">{l.completedAt ? new Date(l.completedAt).toLocaleDateString() : '—'}</td>
                    <td className="p-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant={confirmDiscard === l.id ? 'destructive' : 'outline'}
                          disabled={busy !== null || l.status === 'revoked'}
                          onClick={() => regenerate(l.id)}
                          title={confirmDiscard === l.id
                            ? 'Discards the responses and score already submitted, then issues a fresh link'
                            : 'Issue a fresh link and re-send'}
                        >
                          <RefreshCw /> {confirmDiscard === l.id ? 'Discard & resend' : 'Resend'}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy !== null || l.status === 'revoked'} onClick={() => revoke(l.id)}>
                          <Ban /> Revoke
                        </Button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="border-t border-border p-3 text-xs text-muted-foreground">
              Each row shows the parent name and contact <strong>recorded when the link was generated</strong>. Correcting the roster
              on Student Integration &rarr; Students &amp; Parents changes who future links go to; it never rewrites this history.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
