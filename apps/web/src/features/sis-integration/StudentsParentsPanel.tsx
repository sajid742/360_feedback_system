import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Link2, Pencil, Plus, RefreshCw, Search, Trash2, UserPlus, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api-client';
import { evalAdminApi, type EvaluationLink } from '@/features/external-evaluation/api';
import {
  rosterApi, type RosterOptions, type RosterParent, type RosterStudent, type StudentDetail, type StudentPage,
  type TeachingAssignment,
} from './roster-api';

const selectClass =
  'h-10 w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function fmtDate(v: string | null | undefined): string {
  return v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '—';
}
function msg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/**
 * Where a record came from, shown wherever a record is shown.
 *
 * Three states, and the distinction matters because it predicts what the next
 * sync will do:
 *   Imported   — came from the SIS; a sync may update it.
 *   Corrected  — imported, but fields were fixed here; a sync updates everything
 *                EXCEPT those fields.
 *   Added here — created in this application; a sync never touches it.
 */
function OriginBadge({ origin, localEdits }: { origin?: string; localEdits?: string[] }): JSX.Element {
  if (origin === 'manual') return <Badge variant="info" title="Created in this application. A SIS sync never updates or deactivates it.">Added here</Badge>;
  if (localEdits?.length) {
    return (
      <Badge variant="warning" title={`Imported from the SIS, corrected here. A sync updates everything except: ${localEdits.join(', ')}`}>
        Corrected ({localEdits.length})
      </Badge>
    );
  }
  return <Badge variant="neutral" title="Imported from the SIS. A sync may update it.">Imported</Badge>;
}

/* ========================================================================== */

export function StudentsParentsPanel(): JSX.Element {
  const { has } = usePermissions();
  const canEdit = has('organization.sis.manage');

  const [page, setPage] = useState<StudentPage | null>(null);
  const [options, setOptions] = useState<RosterOptions | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [campus, setCampus] = useState('');
  const [origin, setOrigin] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPageNo(1); }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    setLoading(true);
    rosterApi.students({ search: debounced || undefined, status: status || undefined, campus: campus || undefined, origin: origin || undefined, page: pageNo, pageSize })
      .then((p) => { setPage(p); setError(null); })
      .catch((e) => setError(msg(e, 'Could not load the student roster.')))
      .finally(() => setLoading(false));
  }, [debounced, status, campus, origin, pageNo, pageSize]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { rosterApi.options().then(setOptions).catch(() => setOptions(null)); }, []);

  const refreshAll = useCallback(() => { load(); rosterApi.options().then(setOptions).catch(() => undefined); }, [load]);

  const from = page ? (page.page - 1) * page.pageSize + 1 : 0;
  const to = page ? Math.min(page.page * page.pageSize, page.total) : 0;

  return (
    <div className="grid gap-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      {options && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Students" value={String(options.counts.students)} />
          <Stat label="Guardians" value={String(options.counts.guardians)} />
          <Stat label="Added here" value={String(options.counts.manualStudents + options.counts.manualGuardians)} hint="Students and guardians created in this application. A SIS sync never overwrites or deactivates them." />
          <Stat label="Corrected here" value={String(options.counts.editedStudents)} hint="Imported students with at least one field fixed in this application. A sync leaves those fields alone." />
        </div>
      )}

      <Card className="grid gap-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <Label htmlFor="roster-search" className="text-xs">Search</Label>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="roster-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, registration no. or roll no." className="pl-9" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Status</Label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPageNo(1); }} className={`${selectClass} mt-1 w-36`}>
              <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">Campus</Label>
            <select value={campus} onChange={(e) => { setCampus(e.target.value); setPageNo(1); }} className={`${selectClass} mt-1 w-52`}>
              <option value="">All campuses</option>
              {options?.campuses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs">Source</Label>
            <select value={origin} onChange={(e) => { setOrigin(e.target.value); setPageNo(1); }} className={`${selectClass} mt-1 w-40`}>
              <option value="">Any source</option><option value="sis">Imported</option><option value="manual">Added here</option>
            </select>
          </div>
          <Button variant="outline" onClick={refreshAll} title="Reload"><RefreshCw className="size-4" /></Button>
          {canEdit && <Button onClick={() => setCreating(true)}><Plus className="size-4" /> Add student</Button>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-semibold">Student</th>
                <th className="py-2 pr-3 font-semibold">Registration</th>
                <th className="py-2 pr-3 font-semibold">Roll</th>
                <th className="py-2 pr-3 font-semibold">Campus</th>
                <th className="py-2 pr-3 font-semibold">Class / section</th>
                <th className="py-2 pr-3 font-semibold">Session</th>
                <th className="py-2 pr-3 font-semibold">Guardians</th>
                <th className="py-2 pr-3 font-semibold">Teachers</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2 font-semibold">Source</th>
              </tr>
            </thead>
            <tbody>
              {loading && !page ? (
                <tr><td colSpan={10} className="py-6"><Skeleton className="h-24 w-full" /></td></tr>
              ) : page && page.items.length === 0 ? (
                <tr><td colSpan={10} className="py-8 text-center text-muted-foreground">No students match those filters.</td></tr>
              ) : (
                page?.items.map((s) => (
                  <tr key={s.id} onClick={() => setSelected(s.id)} className="cursor-pointer border-b border-border/60 hover:bg-muted/60">
                    <td className="py-2 pr-3 font-medium">{s.name}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{s.registrationNo}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{s.rollNo || '—'}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{s.campus ?? '—'}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{s.currentClass ?? '—'}{s.currentSection ? ` · ${s.currentSection}` : ''}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{s.session ?? '—'}</td>
                    <td className="py-2 pr-3 tabular-nums">{s.guardianCount ?? 0}</td>
                    <td className="py-2 pr-3 tabular-nums">{s.teacherCount ?? 0}</td>
                    <td className="py-2 pr-3"><Badge variant={s.status === 'active' ? 'success' : 'neutral'}>{s.status}</Badge></td>
                    <td className="py-2"><OriginBadge origin={s.origin} localEdits={s.localEdits} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {page && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm">
            <p className="text-muted-foreground">
              {page.total === 0 ? 'No students' : <>Showing <strong>{from}–{to}</strong> of <strong>{page.total}</strong></>}
            </p>
            <div className="flex items-center gap-2">
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPageNo(1); }} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
                {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <Button variant="outline" size="sm" disabled={page.page <= 1} onClick={() => setPageNo((p) => p - 1)}><ChevronLeft className="size-4" /></Button>
              <span className="tabular-nums text-muted-foreground">{page.page} / {page.totalPages}</span>
              <Button variant="outline" size="sm" disabled={page.page >= page.totalPages} onClick={() => setPageNo((p) => p + 1)}><ChevronRight className="size-4" /></Button>
            </div>
          </div>
        )}
      </Card>

      {selected && <StudentDrawer studentId={selected} canEdit={canEdit} options={options} onClose={() => setSelected(null)} onChanged={refreshAll} />}
      {creating && <StudentDialog mode="create" options={options} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refreshAll(); }} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <Card className="p-3" title={hint}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
    </Card>
  );
}

/* ============================================================ student drawer */

function StudentDrawer({ studentId, canEdit, options, onClose, onChanged }: {
  studentId: string; canEdit: boolean; options: RosterOptions | null; onClose: () => void; onChanged: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [links, setLinks] = useState<EvaluationLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [parentEdit, setParentEdit] = useState<RosterParent | 'new' | null>(null);
  const [teacherPicker, setTeacherPicker] = useState(false);

  const load = useCallback(() => {
    rosterApi.student(studentId).then((d) => { setDetail(d); setError(null); }).catch((e) => setError(msg(e, 'Could not load the student.')));
    // Parent feedback history reuses the endpoint the Parent Evaluations screen
    // already calls — no new query, and the two screens can never disagree.
    evalAdminApi.list(studentId).then(setLinks).catch(() => setLinks([]));
  }, [studentId]);
  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); onChanged(); };
  const s = detail?.student;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-3xl overflow-y-auto bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">{s?.name ?? 'Student'}</h2>
            {s && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{s.registrationNo}</span>
                {s.rollNo ? <span>· Roll {s.rollNo}</span> : null}
                <OriginBadge origin={s.origin} localEdits={s.localEdits} />
                <Badge variant={s.status === 'active' ? 'success' : 'neutral'}>{s.status}</Badge>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canEdit && s && (
              <>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit</Button>
                <Button
                  variant="outline" size="sm"
                  onClick={async () => {
                    try { await rosterApi.setStudentStatus(s.id, s.status === 'active' ? 'inactive' : 'active'); setNote(null); changed(); }
                    catch (e) { setError(msg(e, 'Could not change the status.')); }
                  }}
                >{s.status === 'active' ? 'Deactivate' : 'Reactivate'}</Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}><X className="size-4" /></Button>
          </div>
        </div>

        {error && <div className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
        {note && <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{note}</div>}

        {!detail ? <Skeleton className="h-64 w-full" /> : (
          <div className="grid gap-5">
            {/* ------------------------------------------------ student info */}
            <Card className="grid gap-3 p-4">
              <h3 className="text-sm font-bold">Student information</h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <Field label="Student ID" value={s?.id} mono />
                <Field label="Registration no." value={s?.registrationNo} edited={s?.localEdits?.includes('registrationNo')} />
                <Field label="Roll no." value={s?.rollNo} edited={s?.localEdits?.includes('rollNo')} />
                <Field label="Campus" value={s?.campus} edited={s?.localEdits?.includes('campus')} />
                <Field label="Class" value={s?.currentClass} edited={s?.localEdits?.includes('currentClass')} />
                <Field label="Section" value={s?.currentSection} edited={s?.localEdits?.includes('currentSection')} />
                <Field label="Programme" value={s?.program} />
                <Field label="Faculty" value={s?.faculty} />
                <Field label="Department" value={s?.department} />
                <Field label="Session" value={s?.session} />
                <Field label="Semester" value={s?.semester} />
                <Field label="Gender" value={s?.gender} />
                <Field label="Date of birth" value={s?.dateOfBirth ?? undefined} />
                <Field label="Admission date" value={s?.admissionDate ?? undefined} />
              </dl>
              {s?.updatedLocallyAt && (
                <p className="border-t border-border pt-2 text-xs text-muted-foreground">
                  Last corrected here {fmtDate(s.updatedLocallyAt)}{s.updatedLocallyBy ? ` by ${s.updatedLocallyBy}` : ''}.
                  {s.localEdits?.length ? ` A SIS sync will not overwrite: ${s.localEdits.join(', ')}.` : ''}
                </p>
              )}
            </Card>

            {/* ---------------------------------------------------- guardians */}
            <Card className="grid gap-3 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold">Parents / guardians <span className="font-normal text-muted-foreground">({detail.parents.length})</span></h3>
                {canEdit && <Button size="sm" variant="outline" onClick={() => setParentEdit('new')}><UserPlus className="size-4" /> Add guardian</Button>}
              </div>
              {detail.parents.length === 0 ? (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  No guardian on record — this student cannot receive a parent evaluation link until one is added.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3 font-semibold">Name</th>
                        <th className="py-2 pr-3 font-semibold">Relationship</th>
                        <th className="py-2 pr-3 font-semibold">Mobile</th>
                        <th className="py-2 pr-3 font-semibold">WhatsApp</th>
                        <th className="py-2 pr-3 font-semibold">Email</th>
                        <th className="py-2 pr-3 font-semibold">Lang</th>
                        <th className="py-2 pr-3 font-semibold">Active</th>
                        <th className="py-2 pr-3 font-semibold">Source</th>
                        {canEdit && <th className="py-2 font-semibold" />}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.parents.map((p) => (
                        <tr key={p.id} className="border-b border-border/60">
                          <td className="py-2 pr-3 font-medium">{p.name}<br /><span className="text-xs font-normal text-muted-foreground">{p.id}</span></td>
                          <td className="py-2 pr-3 capitalize text-muted-foreground">{p.relationship}</td>
                          <td className="py-2 pr-3 text-muted-foreground">{p.mobile ?? '—'}</td>
                          <td className="py-2 pr-3 text-muted-foreground">{p.whatsapp ?? '—'}</td>
                          <td className="py-2 pr-3 text-muted-foreground">{p.email ?? '—'}</td>
                          <td className="py-2 pr-3 uppercase text-muted-foreground">{p.preferredLanguage}</td>
                          <td className="py-2 pr-3"><Badge variant={p.active ? 'success' : 'neutral'}>{p.active ? 'yes' : 'no'}</Badge></td>
                          <td className="py-2 pr-3"><OriginBadge origin={p.origin} localEdits={p.localEdits} /></td>
                          {canEdit && (
                            <td className="py-2 text-right">
                              <Button size="sm" variant="ghost" onClick={() => setParentEdit(p)} title="Edit"><Pencil className="size-4" /></Button>
                              <Button
                                size="sm" variant="ghost" title="Remove or deactivate"
                                onClick={async () => {
                                  try {
                                    const r = await rosterApi.removeParent(p.id);
                                    setNote(r.reason ?? null);
                                    changed();
                                  } catch (e) { setError(msg(e, 'Could not remove the guardian.')); }
                                }}
                              ><Trash2 className="size-4" /></Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* ----------------------------------------------------- teachers */}
            <Card className="grid gap-3 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold">Teachers <span className="font-normal text-muted-foreground">({detail.teachers.length})</span></h3>
                  <p className="text-xs text-muted-foreground">These are the teachers a parent of this student is asked to evaluate. Each row is one enrolment onto a teaching assignment.</p>
                </div>
                {canEdit && <Button size="sm" variant="outline" onClick={() => setTeacherPicker(true)}><Link2 className="size-4" /> Attach teacher</Button>}
              </div>
              {detail.teachers.length === 0 ? (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  No teacher is linked to this student, so a parent evaluation would have nobody to evaluate.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3 font-semibold">Teacher</th>
                        <th className="py-2 pr-3 font-semibold">Subject</th>
                        <th className="py-2 pr-3 font-semibold">Class / section</th>
                        <th className="py-2 pr-3 font-semibold">Assignment</th>
                        <th className="py-2 pr-3 font-semibold">Source</th>
                        {canEdit && <th className="py-2 font-semibold" />}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.teachers.map((t) => {
                        const enr = detail.enrollments.find((e) => e.teachingAssignmentId === t.teachingAssignmentId);
                        return (
                          <tr key={t.teachingAssignmentId} className="border-b border-border/60">
                            <td className="py-2 pr-3 font-medium">{t.teacher}</td>
                            <td className="py-2 pr-3 text-muted-foreground">{t.subject}</td>
                            <td className="py-2 pr-3 text-muted-foreground">{enr?.gradeClass ?? '—'}{t.section ? ` · ${t.section}` : ''}</td>
                            <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{t.teachingAssignmentId}</td>
                            <td className="py-2 pr-3"><OriginBadge origin={enr?.origin} /></td>
                            {canEdit && (
                              <td className="py-2 text-right">
                                <Button
                                  size="sm" variant="ghost" title="Detach this teacher from the student"
                                  onClick={async () => {
                                    try { await rosterApi.removeEnrollment(studentId, t.teachingAssignmentId); changed(); }
                                    catch (e) { setError(msg(e, 'Could not detach the teacher.')); }
                                  }}
                                ><Trash2 className="size-4" /></Button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* --------------------------------------- parent feedback history */}
            <Card className="grid gap-3 p-4">
              <h3 className="text-sm font-bold">Parent feedback history</h3>
              {!links ? <Skeleton className="h-16 w-full" /> : links.length === 0 ? (
                <p className="text-sm text-muted-foreground">No parent evaluation link has been generated for this student.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3 font-semibold">Parent</th>
                        <th className="py-2 pr-3 font-semibold">Target</th>
                        <th className="py-2 pr-3 font-semibold">Type</th>
                        <th className="py-2 pr-3 font-semibold">Status</th>
                        <th className="py-2 pr-3 font-semibold">Sent</th>
                        <th className="py-2 font-semibold">Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {links.map((l) => (
                        <tr key={l.id} className="border-b border-border/60">
                          <td className="py-2 pr-3">{l.parent ?? '—'}<br /><span className="font-mono text-xs text-muted-foreground">{l.parentId ?? ''}</span></td>
                          <td className="py-2 pr-3 text-muted-foreground">{l.teacher ?? (l.mode === 'consolidated' ? 'All teachers' : '—')}{l.subject ? ` · ${l.subject}` : ''}</td>
                          <td className="py-2 pr-3 text-muted-foreground">{l.mode === 'consolidated' ? 'Consolidated' : 'Per teacher'}</td>
                          <td className="py-2 pr-3"><Badge variant={l.status === 'completed' ? 'success' : l.status === 'revoked' ? 'danger' : 'info'}>{l.status}</Badge></td>
                          <td className="py-2 pr-3 text-muted-foreground">{fmtDate(l.sentAt)}</td>
                          <td className="py-2 text-muted-foreground">{fmtDate(l.completedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Each row records the parent name and contact <strong>as they were when the link was generated</strong>. Correcting the roster today never rewrites this history.
                  </p>
                </div>
              )}
            </Card>
          </div>
        )}

        {editing && s && <StudentDialog mode="edit" student={s} options={options} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); changed(); }} />}
        {parentEdit && (
          <ParentDialog
            studentId={studentId}
            parent={parentEdit === 'new' ? null : parentEdit}
            onClose={() => setParentEdit(null)}
            onSaved={() => { setParentEdit(null); changed(); }}
          />
        )}
        {teacherPicker && (
          <TeacherPicker
            studentId={studentId}
            attached={new Set(detail?.teachers.map((t) => t.teachingAssignmentId) ?? [])}
            onClose={() => setTeacherPicker(false)}
            onAttached={() => { setTeacherPicker(false); changed(); }}
          />
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono, edited }: { label: string; value?: string | null; mono?: boolean; edited?: boolean }): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}{edited ? <span className="ml-1 text-amber-600" title="Corrected here — a SIS sync will not overwrite it">•</span> : null}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{value || '—'}</dd>
    </div>
  );
}

/* ============================================================ student dialog */

function StudentDialog({ mode, student, options, onClose, onSaved }: {
  mode: 'create' | 'edit'; student?: RosterStudent; options: RosterOptions | null; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const [form, setForm] = useState({
    name: student?.name ?? '', registrationNo: student?.registrationNo ?? '', rollNo: student?.rollNo ?? '',
    gender: student?.gender ?? '', campus: student?.campus ?? '', currentClass: student?.currentClass ?? '',
    currentSection: student?.currentSection ?? '', program: student?.program ?? '', faculty: student?.faculty ?? '',
    department: student?.department ?? '', session: student?.session ?? '', semester: student?.semester ?? '',
    dateOfBirth: student?.dateOfBirth ?? '', admissionDate: student?.admissionDate ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(): Promise<void> {
    setBusy(true); setError(null);
    try {
      if (mode === 'create') await rosterApi.createStudent(form);
      else await rosterApi.updateStudent(student!.id, form);
      onSaved();
    } catch (e) { setError(msg(e, 'Could not save the student.')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{mode === 'create' ? 'Add a student' : `Edit ${student?.name}`}</DialogTitle></DialogHeader>
        {mode === 'edit' && student?.origin !== 'manual' && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            This student was imported from the SIS. Any field you change here is recorded as a local correction and a future sync will leave it alone — every other field still updates from the SIS.
          </p>
        )}
        {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Text label="Full name *" value={form.name} onChange={set('name')} />
          <Text label="Registration no. *" value={form.registrationNo} onChange={set('registrationNo')} />
          <Text label="Roll no." value={form.rollNo} onChange={set('rollNo')} />
          <Text label="Gender" value={form.gender} onChange={set('gender')} />
          <Combo label="Campus" value={form.campus} onChange={set('campus')} options={options?.campuses ?? []} />
          <Combo label="Class" value={form.currentClass} onChange={set('currentClass')} options={options?.classes ?? []} />
          <Combo label="Section" value={form.currentSection} onChange={set('currentSection')} options={options?.sections ?? []} />
          <Combo label="Session" value={form.session} onChange={set('session')} options={options?.sessions ?? []} />
          <Combo label="Semester" value={form.semester} onChange={set('semester')} options={options?.semesters ?? []} />
          <Combo label="Programme" value={form.program} onChange={set('program')} options={options?.programs ?? []} />
          <Combo label="Faculty" value={form.faculty} onChange={set('faculty')} options={options?.faculties ?? []} />
          <Combo label="Department" value={form.department} onChange={set('department')} options={options?.departments ?? []} />
          <Text label="Date of birth" value={form.dateOfBirth ?? ''} onChange={set('dateOfBirth')} placeholder="YYYY-MM-DD" />
          <Text label="Admission date" value={form.admissionDate ?? ''} onChange={set('admissionDate')} placeholder="YYYY-MM-DD" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || !form.name.trim() || !form.registrationNo.trim()}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================================================= parent dialog */

function ParentDialog({ studentId, parent, onClose, onSaved }: {
  studentId: string; parent: RosterParent | null; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const [form, setForm] = useState({
    name: parent?.name ?? '', relationship: parent?.relationship ?? 'father',
    mobile: parent?.mobile ?? '', whatsapp: parent?.whatsapp ?? '', email: parent?.email ?? '',
    preferredLanguage: parent?.preferredLanguage ?? 'en', active: parent?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(): Promise<void> {
    setBusy(true); setError(null);
    try {
      if (parent) await rosterApi.updateParent(parent.id, form);
      else await rosterApi.createParent(studentId, form);
      onSaved();
    } catch (e) { setError(msg(e, 'Could not save the guardian.')); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{parent ? `Edit ${parent.name}` : 'Add a guardian'}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          The contact recorded here is the one used for <strong>new</strong> evaluation links. Links already sent keep the contact they were sent to.
        </p>
        {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Text label="Full name *" value={form.name} onChange={set('name')} />
          <div className="grid gap-1">
            <Label className="text-xs">Relationship</Label>
            <select value={form.relationship} onChange={(e) => set('relationship')(e.target.value)} className={selectClass}>
              <option value="father">Father</option><option value="mother">Mother</option><option value="guardian">Guardian</option>
            </select>
          </div>
          <Text label="Mobile" value={form.mobile ?? ''} onChange={set('mobile')} placeholder="+923001234567" />
          <Text label="WhatsApp" value={form.whatsapp ?? ''} onChange={set('whatsapp')} placeholder="+923001234567" />
          <Text label="Email" value={form.email ?? ''} onChange={set('email')} />
          <div className="grid gap-1">
            <Label className="text-xs">Preferred language</Label>
            <select value={form.preferredLanguage} onChange={(e) => set('preferredLanguage')(e.target.value)} className={selectClass}>
              <option value="en">English</option><option value="ur">Urdu</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
            Active — offered when generating new parent evaluation links
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================================================ teacher picker */

function TeacherPicker({ studentId, attached, onClose, onAttached }: {
  studentId: string; attached: Set<string>; onClose: () => void; onAttached: () => void;
}): JSX.Element {
  const [rows, setRows] = useState<TeachingAssignment[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      rosterApi.teachingAssignments(search || undefined).then(setRows).catch(() => setRows([]));
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const available = useMemo(() => (rows ?? []).filter((a) => !attached.has(a.id)), [rows, attached]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Attach a teacher</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          Pick a teaching assignment — a teacher teaching one subject to one class and section. That is the existing relationship parent feedback follows, so nothing else needs configuring.
        </p>
        {error && <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search teacher, subject, class or section" />
        <div className="max-h-80 overflow-y-auto">
          {!rows ? <Skeleton className="h-32 w-full" /> : available.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No unattached teaching assignment matches.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {available.slice(0, 100).map((a) => (
                  <tr key={a.id} className="border-b border-border/60">
                    <td className="py-2 pr-3 font-medium">{a.teacher}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{a.subject}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{a.gradeClass ?? '—'}{a.section ? ` · ${a.section}` : ''}</td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm" variant="outline" disabled={busy === a.id}
                        onClick={async () => {
                          setBusy(a.id); setError(null);
                          try { await rosterApi.addEnrollment(studentId, a.id); onAttached(); }
                          catch (e) { setError(msg(e, 'Could not attach the teacher.')); }
                          finally { setBusy(null); }
                        }}
                      >Attach</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ small inputs */

function Text({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }): JSX.Element {
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

/** A free-text field with the values already in the roster offered as suggestions —
 *  so a correction reuses an existing campus/class rather than inventing a variant. */
function Combo({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }): JSX.Element {
  const listId = `opt-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} list={listId} />
      <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </div>
  );
}
