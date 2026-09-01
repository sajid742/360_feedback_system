import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { UserNotificationService } from '../../user-notifications/user-notification.service';
import { CommunicationSettingsService } from '../communication.settings';
import { TemplateService, type RenderContext } from './template.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import type { Channel } from '../providers/types';
import { COMM_EVENTS, type CommEvent } from '../comm.events';

export interface DispatchRecipient {
  /** Internal user id — receives an in-app notification (and email if present). */
  userId?: string | null;
  email?: string | null;
  /** Phone / WhatsApp number for sms/whatsapp channels. */
  phone?: string | null;
  /** Placeholder values for this specific recipient. */
  context: RenderContext;
  /** Bell notification tag + deep link (internal users). */
  inAppType?: string;
  inAppLink?: string;
}

export interface DispatchOptions {
  /** Outbound channels; defaults to the org's configured default channels. */
  channels?: Channel[];
  /** Also write an in-app record. Defaults to true when the recipient has a userId. */
  inApp?: boolean;
}

export interface DispatchResult {
  channelsSent: number;
  inAppWritten: boolean;
}

/**
 * Unified dispatcher (Communication v2). A single call renders the event's template
 * and fans out across the configured outbound channels (Email/SMS/WhatsApp) via the
 * provider-agnostic NotificationService AND writes an in-app notification via the
 * user-notifications store — so every "notify" is one call, one policy.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly userNotifications: UserNotificationService,
    private readonly templates: TemplateService,
    private readonly settings: CommunicationSettingsService,
    private readonly feedbackAudit: FeedbackAuditService,
  ) {}

  /** Notify one recipient of one event across all configured channels + in-app. */
  async notifyUser(
    orgId: string,
    createdBy: string | null,
    event: CommEvent,
    recipient: DispatchRecipient,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const branding = await this.templates.branding(orgId);
    const context: RenderContext = { organizationName: branding.organizationName, ...recipient.context };
    const channels = options.channels ?? (await this.templates.defaults(orgId)).channels;

    let channelsSent = 0;
    for (const channel of channels) {
      const address = channel === 'email' ? recipient.email : recipient.phone;
      if (!address) continue; // no reachable address for this channel — skip quietly
      const template = await this.templates.resolve(orgId, event, channel);
      if (!template.isActive) continue;
      try {
        await this.notifications.send(orgId, createdBy, {
          channel,
          recipient: address,
          subject: channel === 'sms' ? undefined : this.templates.render(template.subject, context),
          body: this.templates.render(template.body, context),
          templateKey: `${event}.${channel}`,
        });
        channelsSent++;
      } catch (error) {
        this.logger.warn(`Dispatch ${event}/${channel} to ${address} failed: ${(error as Error).message}`);
      }
    }

    let inAppWritten = false;
    const wantInApp = options.inApp ?? Boolean(recipient.userId);
    if (wantInApp && recipient.userId) {
      // The email template is the canonical rich copy used for the bell text.
      const template = await this.templates.resolve(orgId, event, 'email');
      try {
        await this.userNotifications.create(orgId, {
          userId: recipient.userId,
          type: recipient.inAppType ?? event,
          title: this.templates.render(template.subject, context),
          body: this.templates.render(template.body, context),
          link: recipient.inAppLink,
        });
        inAppWritten = true;
      } catch (error) {
        this.logger.warn(`In-app dispatch ${event} to user ${recipient.userId} failed: ${(error as Error).message}`);
      }
    }

    return { channelsSent, inAppWritten };
  }

  /**
   * Auto-notify every assigned evaluator that a feedback cycle has started.
   * Called when a cycle transitions to 'active'. Never throws — a notification
   * failure must not block the status change.
   */
  async notifyCycleStarted(orgId: string, createdBy: string | null, cycleId: string): Promise<{ recipients: number }> {
    try {
      const cycle = await this.prisma.appraisalCycle.findFirst({
        where: { id: cycleId, organizationId: orgId },
        select: { name: true, startDate: true, endDate: true, submissionDeadline: true },
      });
      if (!cycle) return { recipients: 0 };

      const general = await this.settings.general(orgId);
      const link = `${general.publicBaseUrl.replace(/\/$/, '')}/appraisal`;
      const expiry = fmtDate(cycle.submissionDeadline ?? cycle.endDate);
      const period = `${fmtDate(cycle.startDate)} – ${fmtDate(cycle.endDate)}`;

      const recipients = await this.reviewersOfCycle(orgId, cycleId);
      let count = 0;
      for (const r of recipients) {
        const res = await this.notifyUser(
          orgId,
          createdBy,
          COMM_EVENTS.cycleStarted,
          {
            userId: r.userId,
            email: r.email,
            inAppType: 'cycle_started',
            inAppLink: '/appraisal',
            context: {
              evaluatorName: r.evaluatorName,
              employeeName: r.employeeName,
              feedbackCycle: cycle.name,
              period,
              secureLink: link,
              expiryDate: expiry,
            },
          },
          { inApp: true },
        );
        if (res.channelsSent > 0 || res.inAppWritten) count++;
      }
      this.logger.log(`Cycle ${cycleId} started: notified ${count}/${recipients.length} evaluator(s).`);
      await this.feedbackAudit.record({
        organizationId: orgId,
        action: 'notification.sent',
        actorUserId: createdBy ?? undefined,
        actorRole: createdBy ? undefined : 'System',
        cycleId,
        cycleName: cycle.name,
        entityType: 'appraisal_cycle',
        entityId: cycleId,
        newValue: { event: 'cycle_started', recipients: count },
      });
      return { recipients: count };
    } catch (error) {
      this.logger.error(`notifyCycleStarted failed for ${cycleId}: ${(error as Error).message}`);
      return { recipients: 0 };
    }
  }

  /** Notify distinct evaluators that a cycle has been closed. Never throws. */
  async notifyCycleClosed(orgId: string, createdBy: string | null, cycleId: string): Promise<{ recipients: number }> {
    try {
      const cycle = await this.prisma.appraisalCycle.findFirst({
        where: { id: cycleId, organizationId: orgId },
        select: { name: true },
      });
      if (!cycle) return { recipients: 0 };
      const recipients = await this.reviewersOfCycle(orgId, cycleId);
      let count = 0;
      for (const r of recipients) {
        const res = await this.notifyUser(
          orgId,
          createdBy,
          COMM_EVENTS.cycleClosed,
          {
            userId: r.userId,
            email: r.email,
            inAppType: 'cycle_closed',
            inAppLink: '/appraisal',
            context: { evaluatorName: r.evaluatorName, employeeName: r.employeeName, feedbackCycle: cycle.name },
          },
          { inApp: true },
        );
        if (res.channelsSent > 0 || res.inAppWritten) count++;
      }
      await this.feedbackAudit.record({
        organizationId: orgId,
        action: 'notification.sent',
        actorUserId: createdBy ?? undefined,
        actorRole: createdBy ? undefined : 'System',
        cycleId,
        cycleName: cycle.name,
        entityType: 'appraisal_cycle',
        entityId: cycleId,
        newValue: { event: 'cycle_closed', recipients: count },
      });
      return { recipients: count };
    } catch (error) {
      this.logger.error(`notifyCycleClosed failed for ${cycleId}: ${(error as Error).message}`);
      return { recipients: 0 };
    }
  }

  /**
   * Distinct evaluators of a cycle. A reviewer who evaluates several people is
   * notified once; employeeName collapses to "your colleagues" in that case.
   */
  private async reviewersOfCycle(
    orgId: string,
    cycleId: string,
  ): Promise<{ userId: string; email: string | null; evaluatorName: string; employeeName: string }[]> {
    const assignments = await this.prisma.reviewerAssignment.findMany({
      // Internal reviewers only — external evaluators (parents, …) are notified
      // through their own tokenised-link flow, not cycle in-app/email fan-out.
      where: { cycleId, organizationId: orgId, nominationStatus: 'approved', reviewerEmployeeId: { not: null } },
      include: {
        reviewer: { include: { user: { select: { id: true, email: true, fullName: true } } } },
        participant: { include: { employee: { include: { user: { select: { fullName: true, email: true } } } } } },
      },
    });
    const byUser = new Map<string, { userId: string; email: string | null; evaluatorName: string; appraisees: Set<string> }>();
    for (const a of assignments) {
      if (!a.reviewer) continue;
      const u = a.reviewer.user;
      const appraisee = a.participant.employee.user.fullName ?? a.participant.employee.user.email ?? 'a colleague';
      const entry = byUser.get(u.id) ?? {
        userId: u.id,
        email: u.email ?? null,
        evaluatorName: u.fullName ?? 'there',
        appraisees: new Set<string>(),
      };
      entry.appraisees.add(appraisee);
      byUser.set(u.id, entry);
    }
    return [...byUser.values()].map((e) => ({
      userId: e.userId,
      email: e.email,
      evaluatorName: e.evaluatorName,
      employeeName: e.appraisees.size === 1 ? [...e.appraisees][0] : 'your colleagues',
    }));
  }
}

function fmtDate(date: Date | null): string {
  if (!date) return 'the deadline';
  return date.toISOString().slice(0, 10);
}
