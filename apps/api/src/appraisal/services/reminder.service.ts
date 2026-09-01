import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/auth/current-user';
import { DispatchService } from '../../communication/services/dispatch.service';
import { CommunicationSettingsService } from '../../communication/communication.settings';
import { COMM_EVENTS } from '../../communication/comm.events';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import { CycleService } from './cycle.service';

const DEFAULT_CADENCE_DAYS = 3;
/** Hour of the server day the automatic run fires, when not configured. */
const DEFAULT_SEND_HOUR = 8;

export interface ReminderSettings {
  /** Automatic reminders on/off for the organisation. */
  enabled: boolean;
  /** Minimum days between reminders to the same reviewer. */
  cadenceDays: number;
  /** Hour of the day (0–23, server time) the automatic run fires. */
  sendHour: number;
}
const FINAL_REMINDER_WINDOW_DAYS = 2;

/**
 * Reviewer reminders. Reuses the Communication v2 dispatcher so every reminder is
 * rendered from the tenant's (customisable) Feedback Reminder / Final Reminder
 * template, fanned out across the configured channels, AND written to the in-app
 * notification centre — from a single call. This service only decides *who* to
 * remind and *when*.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: DispatchService,
    private readonly settings: CommunicationSettingsService,
    private readonly cycles: CycleService,
    private readonly feedbackAudit: FeedbackAuditService,
  ) {}

  /** Manual: remind every outstanding reviewer in one cycle immediately. */
  async remindCycle(user: AuthUser, cycleId: string): Promise<{ sent: number }> {
    await this.cycles.getOwned(user.organizationId, cycleId);
    const sent = await this.dispatchForCycle(user.organizationId, cycleId, user.userId, 0);
    return { sent };
  }

  /** Manual: nudge a single outstanding reviewer (HV-2 participation screen). */
  async remindAssignment(user: AuthUser, assignmentId: string): Promise<{ sent: number }> {
    const a = await this.prisma.reviewerAssignment.findFirst({
      where: { id: assignmentId, organizationId: user.organizationId, status: { in: ['pending', 'in_progress'] }, reviewerEmployeeId: { not: null } },
      include: {
        reviewer: { include: { user: { select: { id: true, email: true, fullName: true } } } },
        participant: {
          include: {
            cycle: { select: { name: true, submissionDeadline: true, endDate: true } },
            employee: { include: { user: { select: { fullName: true, email: true } } } },
          },
        },
      },
    });
    if (!a) return { sent: 0 };
    const res = await this.remindOne(user.organizationId, user.userId, a);
    if (res) await this.prisma.reviewerAssignment.update({ where: { id: a.id }, data: { lastRemindedAt: new Date() } });
    return { sent: res ? 1 : 0 };
  }

  /**
   * Auto-reminder across all active cycles, honouring each tenant's cadence and
   * send hour (F6).
   *
   * The job used to be pinned to `EVERY_DAY_AT_8AM`, so an organisation could not
   * move reminders to a time that suits its working day — nudges that land at the
   * wrong hour get ignored, and response rate is what a feedback cycle lives on.
   * It now wakes hourly and does work only for organisations whose configured hour
   * matches, which keeps the scheduler itself unchanged.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runScheduled(): Promise<void> {
    const hour = new Date().getHours();
    const activeCycles = await this.prisma.appraisalCycle.findMany({
      where: { status: 'active', deletedAt: null },
      select: { id: true, organizationId: true },
    });
    for (const cycle of activeCycles) {
      const settings = await this.reminderSettings(cycle.organizationId);
      if (!settings.enabled || settings.sendHour !== hour) continue;
      try {
        const sent = await this.dispatchForCycle(cycle.organizationId, cycle.id, null, settings.cadenceDays);
        if (sent > 0) this.logger.log(`Auto-reminded ${sent} reviewer(s) for cycle ${cycle.id}.`);
      } catch (error) {
        this.logger.warn(`Reminder run failed for cycle ${cycle.id}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Remind each outstanding reviewer in a cycle who hasn't been reminded within
   * `cadenceDays` (0 = ignore cadence, always send). Returns count reminded.
   */
  private async dispatchForCycle(orgId: string, cycleId: string, createdBy: string | null, cadenceDays: number): Promise<number> {
    const cutoff = cadenceDays > 0 ? new Date(Date.now() - cadenceDays * 24 * 60 * 60 * 1000) : null;
    const assignments = await this.prisma.reviewerAssignment.findMany({
      where: {
        cycleId,
        organizationId: orgId,
        status: { in: ['pending', 'in_progress'] },
        nominationStatus: 'approved',
        reviewerEmployeeId: { not: null },
        ...(cutoff ? { OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: cutoff } }] } : {}),
      },
      include: {
        reviewer: { include: { user: { select: { id: true, email: true, fullName: true } } } },
        participant: {
          include: {
            cycle: { select: { name: true, submissionDeadline: true, endDate: true } },
            employee: { include: { user: { select: { fullName: true, email: true } } } },
          },
        },
      },
    });

    let sent = 0;
    for (const a of assignments) {
      const ok = await this.remindOne(orgId, createdBy, a);
      if (ok) {
        await this.prisma.reviewerAssignment.update({ where: { id: a.id }, data: { lastRemindedAt: new Date() } });
        sent++;
      }
    }
    return sent;
  }

  /** Render + dispatch one reminder (chooses Final Reminder near the deadline). */
  private async remindOne(
    orgId: string,
    createdBy: string | null,
    a: {
      reviewer: { user: { id: string; email: string | null; fullName: string | null } } | null;
      participant: {
        cycle: { name: string; submissionDeadline: Date | null; endDate: Date };
        employee: { user: { fullName: string | null; email: string | null } };
      };
    },
  ): Promise<boolean> {
    // External (parent) assignments have no internal reviewer to remind.
    if (!a.reviewer) return false;
    const deadline = a.participant.cycle.submissionDeadline ?? a.participant.cycle.endDate;
    const event = withinDays(deadline, FINAL_REMINDER_WINDOW_DAYS) ? COMM_EVENTS.finalReminder : COMM_EVENTS.feedbackReminder;
    const general = await this.settings.general(orgId);
    const res = await this.dispatch.notifyUser(orgId, createdBy, event, {
      userId: a.reviewer.user.id,
      email: a.reviewer.user.email,
      inAppType: event,
      inAppLink: '/appraisal',
      context: {
        evaluatorName: a.reviewer.user.fullName ?? 'there',
        employeeName: a.participant.employee.user.fullName ?? a.participant.employee.user.email ?? 'a colleague',
        feedbackCycle: a.participant.cycle.name,
        secureLink: `${general.publicBaseUrl.replace(/\/$/, '')}/appraisal`,
        expiryDate: deadline.toISOString().slice(0, 10),
      },
    });
    const ok = res.channelsSent > 0 || res.inAppWritten;
    if (ok) {
      await this.feedbackAudit.record({
        organizationId: orgId,
        action: 'reminder.sent',
        actorUserId: createdBy ?? undefined,
        actorName: createdBy ? undefined : 'System (scheduler)',
        actorRole: createdBy ? undefined : 'System',
        cycleName: a.participant.cycle.name,
        evaluateeName: a.participant.employee.user.fullName ?? a.participant.employee.user.email ?? null,
        evaluatorName: a.reviewer.user.fullName ?? a.reviewer.user.email ?? null,
        entityType: 'reviewer_assignment',
        newValue: { event, channelsSent: res.channelsSent, inApp: res.inAppWritten },
      });
    }
    return ok;
  }

  /** Per-tenant reminder settings (config module 'reminders'). */
  async reminderSettings(orgId: string): Promise<ReminderSettings> {
    const rows = await this.prisma.configuration.findMany({
      where: { organizationId: orgId, module: 'reminders', deletedAt: null },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const enabled = map.get('enabled');
    const cadence = map.get('cadence_days');
    const hour = map.get('send_hour');
    return {
      enabled: enabled === undefined ? true : enabled === true,
      cadenceDays: typeof cadence === 'number' && cadence >= 1 ? cadence : DEFAULT_CADENCE_DAYS,
      sendHour: typeof hour === 'number' && hour >= 0 && hour <= 23 ? hour : DEFAULT_SEND_HOUR,
    };
  }

  /**
   * Update the organisation's reminder settings (F6). Values are clamped: a cadence
   * below a day would nag reviewers on every run, and above a fortnight the reminder
   * would never fire inside a typical cycle.
   */
  async setReminderSettings(user: AuthUser, input: Partial<ReminderSettings>): Promise<ReminderSettings> {
    const current = await this.reminderSettings(user.organizationId);
    const next: ReminderSettings = {
      enabled: input.enabled ?? current.enabled,
      cadenceDays: Math.min(14, Math.max(1, Math.round(Number(input.cadenceDays ?? current.cadenceDays)))),
      sendHour: Math.min(23, Math.max(0, Math.round(Number(input.sendHour ?? current.sendHour)))),
    };
    await this.writeConfig(user, 'enabled', next.enabled);
    await this.writeConfig(user, 'cadence_days', next.cadenceDays);
    await this.writeConfig(user, 'send_hour', next.sendHour);
    return next;
  }

  /** The configurations unique index is partial, so find-then-update/create. */
  private async writeConfig(user: AuthUser, key: string, value: boolean | number): Promise<void> {
    const existing = await this.prisma.configuration.findFirst({
      where: { organizationId: user.organizationId, module: 'reminders', key, deletedAt: null },
      select: { id: true },
    });
    const json = value as unknown as Prisma.InputJsonValue;
    if (existing) {
      await this.prisma.configuration.update({ where: { id: existing.id }, data: { value: json, updatedBy: user.userId } });
    } else {
      await this.prisma.configuration.create({
        data: { organizationId: user.organizationId, module: 'reminders', key, value: json, createdBy: user.userId, updatedBy: user.userId },
      });
    }
  }
}

function withinDays(date: Date, days: number): boolean {
  const ms = date.getTime() - Date.now();
  return ms >= 0 && ms <= days * 24 * 60 * 60 * 1000;
}
