import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../communication/services/notification.service';
import { CONFIG_PERMISSIONS } from '../config/config.permissions';

/**
 * Billing notifications, through the existing communication stack.
 *
 * NO SECOND NOTIFICATION SYSTEM. Everything goes through `NotificationService.send`,
 * so billing mail inherits the tenant's own SMTP settings, the per-channel enable
 * switch, the delivery queue, the `notifications` history and the plan's monthly cap —
 * and shows up in Communication alongside everything else.
 *
 * WHO GETS THEM. The organisation's billing contacts are its users holding
 * `configuration.manage`, resolved through roles. That is the same permission that
 * gates the Licence and Settings screens, so it is already the set of people who
 * administer the account; inventing a separate "billing contact" field would be one
 * more thing to keep current.
 *
 * NEVER FATAL. A notification that cannot be sent must not roll back a recorded
 * payment, so every failure here is logged and swallowed. Losing the email is bad;
 * losing the payment because the email failed would be worse.
 */
@Injectable()
export class BillingNotifyService {
  private readonly log = new Logger(BillingNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  private async recipients(organizationId: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        organizationId,
        status: 'active',
        deletedAt: null,
        userRoles: { some: { role: { deletedAt: null, rolePermissions: { some: { permissionCode: CONFIG_PERMISSIONS.manage } } } } },
      },
      select: { email: true },
      take: 10,
    });
    if (users.length > 0) return users.map((u) => u.email);
    // A tenant whose roles have drifted still needs to hear about its own billing;
    // fall back to the oldest active account rather than sending nowhere.
    const fallback = await this.prisma.user.findFirst({
      where: { organizationId, status: 'active', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    return fallback ? [fallback.email] : [];
  }

  private async send(organizationId: string, templateKey: string, subject: string, body: string): Promise<void> {
    try {
      const to = await this.recipients(organizationId);
      if (to.length === 0) {
        this.log.warn(`No billing recipient for organisation ${organizationId}; "${subject}" was not sent.`);
        return;
      }
      for (const recipient of to) {
        await this.notifications.send(organizationId, null, { channel: 'email', recipient, subject, body, templateKey });
      }
    } catch (err) {
      this.log.warn(`Billing notification "${templateKey}" failed for ${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `instructions` is how the customer actually pays — bank details on the invoice rail,
   * a 1BILL ID on 1BILL. Without it the e-mail says an invoice exists and leaves the
   * recipient to guess what to do about it, which on 1BILL means they cannot pay at all.
   */
  invoiceIssued(orgId: string, number: string, amount: string, instructions?: string): Promise<void> {
    const how = instructions?.trim()
      ? `\n\n${instructions.trim()}`
      : `\n\nPlease quote ${number} as the payment reference.`;
    return this.send(
      orgId,
      'billing.invoice_issued',
      `Invoice ${number} — ${amount}`,
      `Invoice ${number} for ${amount} has been issued for your subscription.${how}\n\n` +
        'Your plan changes once the payment is recorded.',
    );
  }

  paymentReceived(orgId: string, number: string, amount: string, planLabel: string): Promise<void> {
    return this.send(
      orgId,
      'billing.payment_received',
      `Payment received — ${planLabel}`,
      `Thank you. We have recorded ${amount} against invoice ${number}.\n\n` +
        `Your organisation is now on the ${planLabel} plan. The change is already active.`,
    );
  }

  paymentFailed(orgId: string, number: string, reason: string): Promise<void> {
    return this.send(
      orgId,
      'billing.payment_failed',
      `Payment failed — invoice ${number}`,
      `A payment against invoice ${number} did not succeed.\n\n${reason}\n\n` +
        'Your current plan is unaffected for now. Please retry the payment to avoid interruption.',
    );
  }

  planChanged(orgId: string, planLabel: string): Promise<void> {
    return this.send(
      orgId,
      'billing.plan_changed',
      `Your plan is now ${planLabel}`,
      `Your organisation's plan has been changed to ${planLabel}. The change is active immediately.`,
    );
  }

  expiring(orgId: string, days: number, endsAt: Date): Promise<void> {
    return this.send(
      orgId,
      'billing.subscription_expiring',
      `Your subscription ends in ${days} day${days === 1 ? '' : 's'}`,
      `Your subscription period ends on ${endsAt.toISOString().slice(0, 10)}.\n\n` +
        'Renew before then to avoid interruption. Nothing you have recorded is affected either way.',
    );
  }

  grace(orgId: string, graceDays: number): Promise<void> {
    return this.send(
      orgId,
      'billing.subscription_grace',
      'Your subscription has lapsed — grace period started',
      `Your subscription period has ended. You have ${graceDays} day${graceDays === 1 ? '' : 's'} of full access ` +
        'while you renew.\n\nAfter that the account stays open and readable, but new records cannot be added.',
    );
  }

  expired(orgId: string): Promise<void> {
    return this.send(
      orgId,
      'billing.subscription_expired',
      'Your subscription has expired',
      'Your subscription has expired. Your data is untouched and everyone can still sign in, read and export it.\n\n' +
        'New records cannot be added until the subscription is renewed.',
    );
  }

  cancelled(orgId: string, endsAt: Date | null): Promise<void> {
    return this.send(
      orgId,
      'billing.subscription_cancelled',
      'Your subscription will not renew',
      endsAt
        ? `Your subscription is set to end on ${endsAt.toISOString().slice(0, 10)}. You keep full access until then, ` +
            'and nothing you have recorded is deleted.'
        : 'Your subscription has been cancelled. Nothing you have recorded is deleted.',
    );
  }

  usageWarning(orgId: string, label: string, used: number, limit: number): Promise<void> {
    return this.send(
      orgId,
      'billing.usage_warning',
      `Approaching your plan limit — ${label}`,
      `${label}: ${used} of ${limit} used.\n\nYou can upgrade at any time from Subscription in the application.`,
    );
  }
}
