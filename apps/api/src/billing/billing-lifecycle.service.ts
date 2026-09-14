import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EntitlementService } from '../license/entitlement.service';
import { BillingNotifyService } from './billing-notify.service';
import { EXPIRY_WARNING_DAYS } from '../license/license.types';

const DAY = 86_400_000;

/**
 * The clock that moves a subscription through its lifecycle.
 *
 * WHY THIS EXISTS. Before it, nothing transitioned on a date: a trial that ended last
 * month stayed `trialing` with the full plan for ever, and a period that lapsed in
 * January still read `active` in September. Every status was whatever an operator last
 * typed. That was documented as a warning in the Deployment Manual; this removes the
 * warning by doing the work.
 *
 *     trialing ──(trial ends)──► grace ──(graceDays)──► expired
 *     active ──(period ends)───► grace ──(graceDays)──► expired
 *     active + cancelAtPeriodEnd ──(period ends)──► expired   (no grace: they asked)
 *
 * IT NEVER DELETES ANYTHING. `expired` falls back to the always-on core, so the tenant
 * signs in, reads everything, exports it and renews. A billing event must not destroy
 * customer data, and nothing here does.
 *
 * RUNS ONCE A DAY. These are calendar transitions, not real-time ones; an hourly job
 * would send the same warning e-mails twenty-four times. It also short-circuits when
 * a tenant is already in the right state, so it is a cheap no-op on most days.
 *
 * ONE REPLICA. Like the other four scheduled jobs in this application, it has no
 * leader election — running two API replicas would run this twice. See the Deployment
 * Manual's multi-tenant notes.
 */
@Injectable()
export class BillingLifecycleService {
  private readonly log = new Logger(BillingLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
    private readonly notify: BillingNotifyService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runScheduled(): Promise<void> {
    try {
      const result = await this.run(new Date(), { sendWarnings: true });
      if (result.changed > 0 || result.warned > 0) {
        this.log.log(`Billing lifecycle: ${result.changed} status change(s), ${result.warned} warning(s).`);
      }
    } catch (err) {
      // Never let a scheduled run take the process down.
      this.log.error(`Billing lifecycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Exposed so a platform administrator — and the tests — can run it on demand.
   *
   * `sendWarnings` defaults to FALSE for exactly that reason. Status transitions are
   * idempotent — a second sweep the same day finds nothing left to move — but an expiry
   * warning is not: the job decides to warn from the day count alone, so an operator
   * pressing "run now" three times on the seven-day boundary would e-mail the customer
   * three times. The scheduled run passes true; the manual route reports what it would
   * send without sending it.
   */
  async run(
    now: Date = new Date(),
    options: { sendWarnings?: boolean } = {},
  ): Promise<{ changed: number; warned: number; details: string[] }> {
    const sendWarnings = options.sendWarnings ?? false;
    const subs = await this.prisma.subscription.findMany({
      where: { deletedAt: null, status: { in: ['trialing', 'active', 'past_due', 'grace'] } },
    });

    let changed = 0;
    let warned = 0;
    const details: string[] = [];

    for (const sub of subs) {
      const graceMs = Math.max(0, sub.graceDays) * DAY;

      // 1. A trial that has run out.
      if (sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt.getTime() <= now.getTime()) {
        const graceEnds = sub.trialEndsAt.getTime() + graceMs;
        if (now.getTime() > graceEnds) {
          await this.transition(sub.id, sub.organizationId, 'trialing', 'expired', 'trial ended, grace exhausted');
          await this.notify.expired(sub.organizationId);
        } else {
          await this.transition(sub.id, sub.organizationId, 'trialing', 'grace', 'trial ended');
          await this.notify.grace(sub.organizationId, sub.graceDays);
        }
        changed += 1;
        details.push(`${sub.organizationId}: trial ended`);
        continue;
      }

      // 2. A paid period that has run out.
      const periodEnd = sub.currentPeriodEnd?.getTime();
      if ((sub.status === 'active' || sub.status === 'past_due') && periodEnd && periodEnd <= now.getTime()) {
        // A cancellation is a decision already taken, so there is nothing to chase and
        // no grace to give — it simply ends when they said it would.
        if (sub.cancelAtPeriodEnd) {
          await this.transition(sub.id, sub.organizationId, sub.status, 'expired', 'cancelled at period end');
          await this.notify.expired(sub.organizationId);
        } else if (now.getTime() > periodEnd + graceMs) {
          await this.transition(sub.id, sub.organizationId, sub.status, 'expired', 'period ended, grace exhausted');
          await this.notify.expired(sub.organizationId);
        } else {
          await this.transition(sub.id, sub.organizationId, sub.status, 'grace', 'period ended');
          await this.notify.grace(sub.organizationId, sub.graceDays);
        }
        changed += 1;
        details.push(`${sub.organizationId}: period ended`);
        continue;
      }

      // 3. Grace that has run out.
      if (sub.status === 'grace') {
        // A subscription put into grace by hand may carry no period or trial date at
        // all. Falling back to when the row was last touched means it still ends, rather
        // than sitting in grace — with the full plan — for ever.
        const from = sub.currentPeriodEnd?.getTime() ?? sub.trialEndsAt?.getTime() ?? sub.updatedAt?.getTime();
        if (from && now.getTime() > from + graceMs) {
          await this.transition(sub.id, sub.organizationId, 'grace', 'expired', 'grace exhausted');
          await this.notify.expired(sub.organizationId);
          changed += 1;
          details.push(`${sub.organizationId}: grace exhausted`);
        }
        continue;
      }

      // 4. Nothing to change — is anything about to end?
      const endsAt = sub.status === 'trialing' ? sub.trialEndsAt : sub.currentPeriodEnd;
      if (endsAt) {
        const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / DAY);
        // A single warning window, not one per day: the job is idempotent only because
        // it fires on exact day boundaries.
        if (daysLeft === EXPIRY_WARNING_DAYS || daysLeft === 7 || daysLeft === 1) {
          if (sendWarnings) await this.notify.expiring(sub.organizationId, daysLeft, endsAt);
          warned += 1;
          details.push(`${sub.organizationId}: ${daysLeft} day(s) left${sendWarnings ? '' : ' (not sent — manual run)'}`);
        }
      }
    }

    return { changed, warned, details };
  }

  private async transition(id: string, organizationId: string, from: string, to: string, reason: string): Promise<void> {
    await this.prisma.subscription.update({ where: { id }, data: { status: to } });
    this.entitlements.invalidate(organizationId);
    // Written to the tenant's own audit log: a customer asking "why did this stop
    // working?" deserves an answer they can see, not one only the vendor can.
    await this.audit.record({
      organizationId,
      userId: null,
      action: 'billing.subscription.lifecycle',
      entityType: 'subscription',
      entityId: id,
      previousValue: { status: from },
      newValue: { status: to, reason },
    });
    this.log.log(`Organisation ${organizationId}: ${from} → ${to} (${reason}).`);
  }
}
