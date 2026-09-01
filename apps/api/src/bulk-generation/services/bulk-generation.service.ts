import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';
import { SIS_PROVIDER, type SisProvider } from '../../sis/sis-provider.interface';
import { CycleService } from '../../appraisal/services/cycle.service';
import { EvaluationLinkService } from '../../external-evaluation/services/evaluation-link.service';
import { PlanService, type BulkConfig, type DeepPartial, type EvaluateePlan } from './plan.service';

type Dict = Record<string, unknown>;

interface ParentItem {
  employeeId: string;
  teacherId: string;
  studentId: string;
  studentName: string;
  teachingAssignmentId: string;
  parentId: string;
  parentName: string;
  channel: 'whatsapp' | 'email' | 'sms' | null;
  recipient: string | null;
}

interface ParentResolution {
  items: ParentItem[];
  teachersNoParents: string[]; // evaluatee names (mapped teachers with no student/parent link)
}

export interface BulkInput {
  scopeType: 'all' | 'campus' | 'department';
  scopeId?: string | null;
  config?: DeepPartial<BulkConfig>;
}

export interface GenerateInput extends BulkInput {
  cycle: { name: string; startDate: string; endDate: string; submissionDeadline?: string; templateId?: string; ratingScaleId?: string };
  /**
   * Optional questionnaire per evaluator type, e.g. { peer: <id>, subordinate: <id> }.
   * A code left out inherits `cycle.templateId`, which is how generation has always
   * behaved. Lets one run create a cycle where peers rate collaboration and
   * subordinates rate delegation, while both still share competencies such as
   * Communication so the perspectives stay comparable.
   */
  quadrantTemplates?: Partial<Record<'self' | 'manager' | 'peer' | 'subordinate' | 'parent', string>>;
}

const SOURCE_DEFS: Record<string, { label: string; weight: number; anonymous: boolean }> = {
  self: { label: 'Self', weight: 1, anonymous: false },
  manager: { label: 'Line Manager', weight: 2, anonymous: false },
  peer: { label: 'Peer', weight: 1, anonymous: true },
  subordinate: { label: 'Subordinate', weight: 1, anonymous: true },
  parent: { label: 'Parents', weight: 1, anonymous: true },
};

/**
 * The quadrant a given rung of the reporting line writes into.
 *
 * Level 1 keeps the `manager` code, label and weight the generator has always used,
 * so a single-level cycle is byte-for-byte what it was. Deeper levels get a halved
 * default weight — a sensible starting shape (2 / 1 / 0.5), not a rule: the weights
 * are editable per cycle on the Sources tab afterwards.
 */
function managerSourceDef(level: number): { code: string; label: string; weight: number; anonymous: boolean } {
  if (level <= 1) return { code: 'manager', ...SOURCE_DEFS.manager };
  const label = level === 2 ? "Manager's Manager (L2)" : `Senior Line Manager (L${level})`;
  return { code: `manager_l${level}`, label, weight: Math.max(0.25, 2 / 2 ** (level - 1)), anonymous: false };
}

@Injectable()
export class BulkGenerationService {
  private readonly logger = new Logger(BulkGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly plan: PlanService,
    private readonly cycles: CycleService,
    private readonly evaluationLinks: EvaluationLinkService,
    @Inject(SIS_PROVIDER) private readonly sis: SisProvider,
  ) {}

  /* ------------------------------------------------------------------ */
  /* Scope options for the selector.                                     */
  /* ------------------------------------------------------------------ */
  async scopes(orgId: string): Promise<Dict> {
    const employees = await this.prisma.employee.findMany({
      where: { organizationId: orgId, deletedAt: null, status: 'active' },
      select: { campusId: true, departmentId: true },
    });
    const campusIds = [...new Set(employees.map((e) => e.campusId).filter((v): v is string => !!v))];
    const [campuses, departments] = await Promise.all([
      campusIds.length
        ? this.prisma.organization.findMany({ where: { id: { in: campusIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
        : Promise.resolve([]),
      this.prisma.department.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { id: true, name: true, parentId: true, unitType: true }, orderBy: { name: 'asc' } }),
    ]);
    const empByCampus = new Map<string, number>();
    const empByDept = new Map<string, number>();
    for (const e of employees) {
      if (e.campusId) empByCampus.set(e.campusId, (empByCampus.get(e.campusId) ?? 0) + 1);
      if (e.departmentId) empByDept.set(e.departmentId, (empByDept.get(e.departmentId) ?? 0) + 1);
    }
    return {
      totalActiveEmployees: employees.length,
      campuses: campuses.map((c) => ({ id: c.id, name: c.name, employees: empByCampus.get(c.id) ?? 0 })),
      departments: departments.map((d) => ({ id: d.id, name: d.name, parentId: d.parentId, unitType: d.unitType, employees: empByDept.get(d.id) ?? 0 })),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Preview (no writes).                                                */
  /* ------------------------------------------------------------------ */
  async preview(orgId: string, input: BulkInput): Promise<Dict> {
    const config = this.plan.mergeConfig(input.config);
    const scope = await this.plan.resolveScope(orgId, input.scopeType, input.scopeId);
    const plans = await this.plan.buildPlan(orgId, scope, config);
    const parents = config.evaluators.parent && config.includeParents ? await this.resolveParents(plans, config) : { items: [], teachersNoParents: [] };
    return this.summarize(scope, config, plans, parents);
  }

  /* ------------------------------------------------------------------ */
  /* Generate (writes: new cycle + sources + participants + assignments  */
  /* + parent links + optional activate/notify + audit run).             */
  /* ------------------------------------------------------------------ */
  async generate(user: AuthUser, ctx: RequestContext, input: GenerateInput): Promise<Dict> {
    if (!input.cycle?.name?.trim()) throw new BadRequestException('Cycle name is required.');
    if (!input.cycle.startDate || !input.cycle.endDate) throw new BadRequestException('Cycle start and end dates are required.');
    // A cycle with no usable questionnaire gives every notified evaluator an empty,
    // unsubmittable form (F-C3). Refuse up front instead of creating a cycle and
    // emailing people who then cannot complete it.
    await this.assertUsableTemplate(orgId(user), input.cycle.templateId);
    const config = this.plan.mergeConfig(input.config);
    const scope = await this.plan.resolveScope(orgId(user), input.scopeType, input.scopeId);
    const plans = await this.plan.buildPlan(orgId(user), scope, config);
    const parents = config.evaluators.parent && config.includeParents ? await this.resolveParents(plans, config) : { items: [], teachersNoParents: [] };

    const skipped: Dict[] = [];
    const failed: Dict[] = [];
    let assignmentsCreated = 0;
    let messagesQueued = 0;

    // 1) Create the new cycle (draft).
    const { id: cycleId } = await this.cycles.create(user, ctx, {
      name: input.cycle.name.trim(),
      startDate: input.cycle.startDate,
      endDate: input.cycle.endDate,
      submissionDeadline: input.cycle.submissionDeadline,
      templateId: input.cycle.templateId,
      ratingScaleId: input.cycle.ratingScaleId,
    });

    // 2) Feedback sources for the enabled evaluator types (+ parent if used).
    const enabled = Object.entries(config.evaluators).filter(([, on]) => on).map(([k]) => k);
    // One quadrant per manager LEVEL. `manager` covers level 1; levels 2+ are appended
    // so the enabled list stays the single source of truth for what gets created.
    const withLevels = enabled.flatMap((code) =>
      code === 'manager'
        ? Array.from({ length: Math.max(1, config.managerLevels) }, (_v, i) => managerSourceDef(i + 1).code)
        : [code]);
    const sourceByCode = new Map<string, string>();
    for (const code of withLevels) {
      const def = /^manager(_l\d+)?$/.test(code)
        ? managerSourceDef(code === 'manager' ? 1 : Number(code.slice('manager_l'.length)))
        : SOURCE_DEFS[code];
      if (!def) continue;
      const quadrantTemplate = input.quadrantTemplates?.[code as 'self' | 'manager' | 'peer' | 'subordinate' | 'parent'];
      if (quadrantTemplate) await this.assertUsableTemplate(orgId(user), quadrantTemplate);
      const src = await this.prisma.feedbackSource.create({
        data: {
          cycleId,
          code,
          label: def.label,
          weight: def.weight,
          requiredCount: 1,
          isAnonymous: def.anonymous,
          isActive: true,
          // NULL = inherit the cycle questionnaire (previous behaviour).
          templateId: quadrantTemplate ?? null,
        },
        select: { id: true },
      });
      sourceByCode.set(code, src.id);
    }

    // 3) Enroll participants (evaluatees) and 4) create internal reviewer assignments.
    //
    // Performance (F-P1): this used to issue ONE INSERT per participant and one per
    // assignment — roughly 9,000 sequential round-trips for a 1,500-person cycle
    // (measured ~12.5s, and worse than any sensible gateway timeout at 2,000+).
    // Rows are now built in memory and written with chunked `createMany`, which is
    // the same data in a few statements. Duplicates can only arise WITHIN the batch
    // (the cycle is brand new), so they are de-duplicated up front — keeping the
    // per-row "skipped" reporting the summary shows.
    const CHUNK = 1000;
    await this.prisma.appraisalParticipant.createMany({
      data: plans.map((p) => ({ cycleId, employeeId: p.employee.id })),
      skipDuplicates: true,
    });
    const participantRows = await this.prisma.appraisalParticipant.findMany({
      where: { cycleId },
      select: { id: true, employeeId: true },
    });
    const participantByEmployee = new Map(participantRows.map((r) => [r.employeeId, r.id]));

    const assignmentRows: {
      organizationId: string; cycleId: string; participantId: string; sourceId: string;
      reviewerEmployeeId: string; reviewerType: string; nominationStatus: string;
    }[] = [];
    const seen = new Set<string>();
    for (const p of plans) {
      const participantId = participantByEmployee.get(p.employee.id);
      if (!participantId) {
        failed.push({ type: 'participant', who: p.employee.name, reason: 'Could not enroll participant.' });
        continue;
      }
      for (const ev of p.evaluators) {
        const sourceId = sourceByCode.get(ev.sourceCode);
        if (!sourceId) continue;
        const key = `${participantId}:${sourceId}:${ev.reviewerEmployeeId}`;
        if (seen.has(key)) {
          skipped.push({ type: ev.sourceCode, who: p.employee.name, reason: 'Duplicate assignment (already assigned).' });
          continue;
        }
        seen.add(key);
        assignmentRows.push({
          organizationId: orgId(user), cycleId, participantId, sourceId,
          reviewerEmployeeId: ev.reviewerEmployeeId, reviewerType: 'internal', nominationStatus: 'approved',
        });
      }
    }
    for (let i = 0; i < assignmentRows.length; i += CHUNK) {
      const batch = assignmentRows.slice(i, i + CHUNK);
      const res = await this.prisma.reviewerAssignment.createMany({ data: batch, skipDuplicates: true });
      assignmentsCreated += res.count;
    }

    // 5) Parent links (reuse EvaluationLinkService, targeting THIS new cycle).
    const parentSend = config.notify;
    for (const item of parents.items) {
      try {
        await this.evaluationLinks.create(
          user,
          { studentId: item.studentId, teachingAssignmentId: item.teachingAssignmentId, parentId: item.parentId, send: parentSend && !!item.recipient, channel: item.channel ?? undefined },
          cycleId,
          ctx,
        );
        assignmentsCreated++;
        if (parentSend && item.recipient) messagesQueued++;
      } catch (e) {
        failed.push({ type: 'parent', who: `${item.studentName} → parent`, reason: (e as Error).message });
      }
    }

    // 6) Optionally activate the cycle → fires the existing evaluator-notification path.
    let status = 'draft';
    if (config.notify) {
      try {
        await this.cycles.setStatus(user, ctx, cycleId, 'active');
        status = 'active';
        // Internal evaluators are notified in-app/email on activation (dispatch fan-out).
        messagesQueued += assignmentsCreated - parents.items.length; // internal assignments notified
      } catch (e) {
        this.logger.warn(`bulk activate failed: ${(e as Error).message}`);
      }
    }

    // 7) Audit run + summary.
    const summary = this.summarize(scope, config, plans, parents);
    const runStatus = failed.length ? (assignmentsCreated ? 'partial' : 'failed') : 'completed';
    const run = await this.prisma.bulkGenerationRun.create({
      data: {
        organizationId: orgId(user),
        cycleId,
        cycleName: input.cycle.name.trim(),
        initiatedBy: user.userId,
        initiatedByName: (user as { email?: string }).email ?? null,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        scopeName: scope.scopeName,
        status: runStatus,
        config: config as unknown as object,
        summary: summary as unknown as object,
        skipped: skipped as unknown as object,
        failed: failed as unknown as object,
        assignmentsCreated,
        skippedCount: skipped.length,
        failedCount: failed.length,
        messagesQueued: Math.max(0, messagesQueued),
        completedAt: new Date(),
      },
      select: { id: true },
    });
    await this.audit.record({
      organizationId: orgId(user), userId: user.userId,
      action: 'appraisal.bulk.generate', entityType: 'appraisal_cycle', entityId: cycleId,
      newValue: { runId: run.id, scope: scope.scopeName, assignmentsCreated, skipped: skipped.length, failed: failed.length },
      ip: ctx.ip, device: ctx.device,
    });

    return {
      runId: run.id,
      cycleId,
      cycleStatus: status,
      summary,
      assignmentsCreated,
      skippedCount: skipped.length,
      failedCount: failed.length,
      messagesQueued: Math.max(0, messagesQueued),
      skipped,
      failed,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Audit history.                                                      */
  /* ------------------------------------------------------------------ */
  async listRuns(orgId: string): Promise<Dict[]> {
    const rows = await this.prisma.bulkGenerationRun.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => ({
      id: r.id, cycleId: r.cycleId, cycleName: r.cycleName, initiatedByName: r.initiatedByName,
      scopeType: r.scopeType, scopeName: r.scopeName, status: r.status,
      assignmentsCreated: r.assignmentsCreated, skippedCount: r.skippedCount, failedCount: r.failedCount,
      messagesQueued: r.messagesQueued, createdAt: r.createdAt, completedAt: r.completedAt,
    }));
  }

  async getRun(orgId: string, id: string): Promise<Dict> {
    const r = await this.prisma.bulkGenerationRun.findFirst({ where: { id, organizationId: orgId } });
    if (!r) throw new BadRequestException('Run not found.');
    return {
      id: r.id, cycleId: r.cycleId, cycleName: r.cycleName, initiatedByName: r.initiatedByName,
      scopeType: r.scopeType, scopeName: r.scopeName, status: r.status,
      config: r.config, summary: r.summary, skipped: r.skipped, failed: r.failed,
      assignmentsCreated: r.assignmentsCreated, skippedCount: r.skippedCount, failedCount: r.failedCount,
      messagesQueued: r.messagesQueued, createdAt: r.createdAt, completedAt: r.completedAt,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Questionnaire validation (F-C3).                                    */
  /* ------------------------------------------------------------------ */
  /**
   * A generated cycle must have a questionnaire that actually contains questions,
   * otherwise every evaluator receives an empty form and cannot submit. Validates
   * that the template exists, belongs to this organization, and has at least one
   * question attached.
   */
  private async assertUsableTemplate(organizationId: string, templateId?: string): Promise<void> {
    if (!templateId) {
      throw new BadRequestException(
        'Select a questionnaire template for the new cycle. Without one, evaluators receive an empty form they cannot submit.',
      );
    }
    const template = await this.prisma.questionnaireTemplate.findFirst({
      where: { id: templateId, organizationId, deletedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!template) throw new BadRequestException('The selected questionnaire template was not found in this organization.');
    const questionCount = await this.prisma.sectionQuestion.count({
      where: { section: { templateId: template.id } },
    });
    if (questionCount === 0) {
      throw new BadRequestException(
        `The questionnaire "${template.name}" has no questions. Add questions to it before generating a cycle.`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Parent resolution from the SIS (active students/parents only).      */
  /* ------------------------------------------------------------------ */
  private async resolveParents(plans: EvaluateePlan[], config: BulkConfig): Promise<ParentResolution> {
    const teachers = plans.filter((p) => p.teacherId);
    if (teachers.length === 0) return { items: [], teachersNoParents: [] };

    // Active student status map (one fetch).
    let studentStatus = new Map<string, string>();
    try {
      const students = await this.sis.getStudents({ limit: 5000 } as never);
      studentStatus = new Map((students as { id: string; status?: string }[]).map((s) => [s.id, s.status ?? 'active']));
    } catch { /* if SIS list fails, don't hard-block; treat all as active */ }

    const teachersCache = new Map<string, { teacherId: string; teachingAssignmentId: string }[]>();
    const parentsCache = new Map<string, { id: string; name: string; whatsapp?: string | null; mobile?: string | null; email?: string | null; active?: boolean }[]>();
    const getTeachersOfStudent = async (sid: string) => {
      if (!teachersCache.has(sid)) teachersCache.set(sid, (await this.sis.getTeachersOfStudent(sid).catch(() => [])) as never);
      return teachersCache.get(sid)!;
    };
    const getParents = async (sid: string) => {
      if (!parentsCache.has(sid)) parentsCache.set(sid, (await this.sis.getParentsOfStudent(sid).catch(() => [])) as never);
      return parentsCache.get(sid)!;
    };

    const items: ParentItem[] = [];
    const teachersNoParents: string[] = [];
    const seen = new Set<string>(); // dedupe (student|TA|parent)
    const CAP = 5000;

    for (const p of teachers) {
      const teacherId = p.teacherId!;
      let produced = 0;
      const students = (await this.sis.getStudentsOfTeacher(teacherId).catch(() => [])) as { id: string; name: string }[];
      for (const st of students) {
        if (items.length >= CAP) break;
        if ((studentStatus.get(st.id) ?? 'active') !== 'active') continue; // inactive student excluded
        const tlinks = (await getTeachersOfStudent(st.id)).filter((t) => t.teacherId === teacherId);
        if (tlinks.length === 0) continue;
        const parents = (await getParents(st.id)).filter((pa) => pa.active !== false); // inactive parent excluded
        for (const ta of tlinks) {
          for (const pa of parents) {
            const key = `${st.id}|${ta.teachingAssignmentId}|${pa.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const channel = this.pickChannel(config.channels, pa);
            items.push({
              employeeId: p.employee.id, teacherId, studentId: st.id, studentName: st.name,
              teachingAssignmentId: ta.teachingAssignmentId, parentId: pa.id, parentName: pa.name,
              channel, recipient: this.pickRecipient(channel, pa),
            });
            produced++;
          }
        }
      }
      if (produced === 0) teachersNoParents.push(p.employee.name);
    }
    return { items, teachersNoParents };
  }

  private pickChannel(channels: string[], pa: { whatsapp?: string | null; mobile?: string | null; email?: string | null }): 'whatsapp' | 'email' | 'sms' | null {
    if (channels.includes('whatsapp') && (pa.whatsapp || pa.mobile)) return 'whatsapp';
    if (channels.includes('email') && pa.email) return 'email';
    if (channels.includes('sms') && (pa.mobile || pa.whatsapp)) return 'sms';
    return null;
  }
  private pickRecipient(channel: string | null, pa: { whatsapp?: string | null; mobile?: string | null; email?: string | null }): string | null {
    if (channel === 'whatsapp') return pa.whatsapp ?? pa.mobile ?? null;
    if (channel === 'sms') return pa.mobile ?? pa.whatsapp ?? null;
    if (channel === 'email') return pa.email ?? null;
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Summary shared by preview + generate.                               */
  /* ------------------------------------------------------------------ */
  private summarize(scope: { scopeType: string; scopeName: string }, config: BulkConfig, plans: EvaluateePlan[], parents: ParentResolution): Dict {
    let managers = 0, peers = 0, subordinates = 0, selfA = 0;
    // Per-level manager counts, so the preview says "40 level-1, 38 level-2, 22 level-3"
    // rather than one opaque total.
    const managersByLevel = new Map<number, number>();
    const missingManagers: string[] = [], noPeers: string[] = [], noSubordinates: string[] = [];
    const shortChains: string[] = [];
    for (const p of plans) {
      for (const ev of p.evaluators) {
        if (/^manager(_l\d+)?$/.test(ev.sourceCode)) {
          managers++;
          const lvl = ev.sourceCode === 'manager' ? 1 : Number(ev.sourceCode.slice('manager_l'.length));
          managersByLevel.set(lvl, (managersByLevel.get(lvl) ?? 0) + 1);
        }
        else if (ev.sourceCode === 'peer') peers++;
        else if (ev.sourceCode === 'subordinate') subordinates++;
        else if (ev.sourceCode === 'self') selfA++;
      }
      if (config.managerLevels > 1 && p.issues.missingManagerLevels.length > 0) {
        shortChains.push(`${p.employee.name} (no level ${p.issues.missingManagerLevels.join(', ')})`);
      }
      if (config.evaluators.manager && p.issues.missingManager) missingManagers.push(p.employee.name);
      if (config.evaluators.peer && p.issues.noPeers) noPeers.push(p.employee.name);
      if (config.evaluators.subordinate && p.issues.noSubordinates) noSubordinates.push(p.employee.name);
    }
    const parentEvaluations = parents.items.length;
    const uniqueStudents = new Set(parents.items.map((i) => i.studentId)).size;
    const uniqueParents = new Set(parents.items.map((i) => i.parentId)).size;
    const totalAssignments = managers + peers + subordinates + selfA + parentEvaluations;

    // Message projection.
    const wa = parents.items.filter((i) => i.channel === 'whatsapp' && i.recipient).length;
    const em = parents.items.filter((i) => i.channel === 'email' && i.recipient).length;
    const sm = parents.items.filter((i) => i.channel === 'sms' && i.recipient).length;
    const internalNotified = config.notify ? managers + peers + subordinates + selfA : 0;
    const parentMsgs = config.notify ? wa + em + sm : 0;

    return {
      scope: { type: scope.scopeType, name: scope.scopeName },
      config,
      employees: plans.length,
      managers, peers, subordinates, selfAssignments: selfA,
      managerLevels: config.managerLevels,
      managersByLevel: [...managersByLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, count]) => ({ level, count })),
      parentEvaluations,
      teachers: new Set(parents.items.map((i) => i.employeeId)).size,
      students: uniqueStudents,
      parents: uniqueParents,
      totalAssignments,
      messages: { whatsapp: wa, email: em, sms: sm, inApp: internalNotified, total: parentMsgs + internalNotified },
      issues: {
        missingManagers, noPeers, noSubordinates, shortChains, teachersNoParents: parents.teachersNoParents,
      },
      counts: {
        missingManagers: missingManagers.length,
        shortChains: shortChains.length,
        noPeers: noPeers.length,
        noSubordinates: noSubordinates.length,
        teachersNoParents: parents.teachersNoParents.length,
      },
    };
  }
}

function orgId(user: AuthUser): string {
  return user.organizationId;
}
