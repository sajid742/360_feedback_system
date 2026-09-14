import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BillingProvider } from '../billing.types';
import { InvoiceBillingProvider } from './invoice.provider';
import { OneBillProvider } from './onebill.provider';

/**
 * Injection token for "the provider this installation collects money with".
 *
 * Until now `InvoiceBillingProvider` was injected as a concrete class in four places,
 * which meant `BILLING_PROVIDER` selected nothing at all — the variable was documented
 * and read by exactly no one. Adding a second adapter is what made that a real defect
 * rather than an unused abstraction.
 */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/**
 * Every adapter this build knows about, keyed the way the `provider` column and the
 * webhook URL spell it.
 *
 * WHY A REGISTRY AND NOT JUST THE SELECTED ONE. A webhook arrives at
 * `/billing/webhook/:provider` and must be verified with the signing scheme of the
 * adapter it came from — not with whatever this installation is currently configured
 * to send with. The two differ exactly when it matters most: during a migration, when
 * yesterday's provider is still delivering callbacks for bills it is still collecting.
 * Verifying those with the new provider's secret would reject every one of them.
 */
@Injectable()
export class BillingProviderRegistry {
  private readonly byKey = new Map<string, BillingProvider>();

  constructor(
    invoice: InvoiceBillingProvider,
    onebill: OneBillProvider,
    @Inject(BILLING_PROVIDER) private readonly selected: BillingProvider,
  ) {
    for (const p of [invoice, onebill]) this.byKey.set(p.key, p);
  }

  /** The adapter this installation issues new bills with. */
  active(): BillingProvider {
    return this.selected;
  }

  /**
   * The adapter a stored row or an inbound callback belongs to.
   *
   * An unknown key returns null rather than falling back to the active provider: a
   * callback for a provider this build does not have is a misconfiguration or a probe,
   * and quietly verifying it with someone else's secret would be worse than refusing it.
   */
  byProviderKey(key: string): BillingProvider | null {
    return this.byKey.get(key) ?? null;
  }

  known(): string[] {
    return [...this.byKey.keys()];
  }
}

/**
 * Choose the adapter from the environment, once, at startup.
 *
 * An unrecognised `BILLING_PROVIDER` falls back to invoice billing with a loud warning
 * rather than refusing to boot. Collecting money by bank transfer when the variable is
 * misspelt is a recoverable inconvenience; an application that will not start because
 * of a typo in an optional setting is an outage.
 */
export const billingProviderFactory = {
  provide: BILLING_PROVIDER,
  inject: [InvoiceBillingProvider, OneBillProvider],
  useFactory: (invoice: InvoiceBillingProvider, onebill: OneBillProvider): BillingProvider => {
    const log = new Logger('BillingProvider');
    const configured = (process.env.BILLING_PROVIDER ?? '').trim().toLowerCase();
    const all: BillingProvider[] = [invoice, onebill];
    if (!configured) return invoice;
    const hit = all.find((p) => p.key === configured);
    if (hit) {
      log.log(`Billing provider: ${hit.key}.`);
      return hit;
    }
    log.warn(
      `BILLING_PROVIDER="${configured}" is not a provider this build has ` +
        `(${all.map((p) => p.key).join(', ')}). Falling back to invoice billing.`,
    );
    return invoice;
  },
};
