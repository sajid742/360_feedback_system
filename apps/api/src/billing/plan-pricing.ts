/**
 * What each plan costs.
 *
 * PRICE IS DATA, FEATURES ARE CODE. `plans.ts` says what a plan *is* — its modules and
 * limits — and is reviewed and shipped with the guards that enforce it. Price is not
 * like that: it changes for commercial reasons, sometimes for one customer, and must
 * never need a release. So the numbers below are only **defaults**, seeded into
 * `plan_prices` on first run; after that the table is the truth and a platform
 * administrator edits it.
 *
 * Nothing else in the application contains a price. A screen that wants one asks for
 * it; a checkout that needs one looks it up server-side. That is also the control that
 * stops a browser proposing its own amount.
 */
import type { PlanCode } from '../license/plans';
import type { BillingInterval } from './billing.types';

/** The billing currency for this installation. PKR by default — the target market. */
export const billingCurrency = (): string => (process.env.BILLING_CURRENCY ?? 'PKR').toUpperCase();

/**
 * Sales tax as a percentage, applied to the subtotal. Pakistan's provincial sales tax
 * on services varies by province and by whether the customer is registered, so it is a
 * setting rather than a constant, and it defaults to 0 — charging the wrong tax is
 * worse than charging none and correcting the invoice.
 */
export const billingTaxPercent = (): number => {
  const n = Number(process.env.BILLING_TAX_PERCENT ?? '0');
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
};

/** How many days a customer gets to pay before an invoice is overdue. */
export const invoiceDueDays = (): number => {
  const n = Number(process.env.BILLING_DUE_DAYS ?? '14');
  return Number.isFinite(n) && n > 0 && n <= 180 ? Math.floor(n) : 14;
};

/**
 * Default list prices, in MINOR units (paisa), for the default currency.
 *
 * The annual figure is ten months rather than twelve — the usual two-months-free
 * incentive to pay yearly, which for invoice billing also halves the number of bank
 * transfers you have to chase.
 */
export const DEFAULT_PRICES: Record<PlanCode, Record<BillingInterval, number>> = {
  // Free. Priced explicitly at zero rather than omitted, so "is this plan free?" has
  // one answer — the price — instead of a special case somewhere in the code.
  starter: { month: 0, year: 0 },
  professional: { month: 25_000_00, year: 250_000_00 },
  enterprise: { month: 75_000_00, year: 750_000_00 },
};

/** A plan with no price is free; a plan priced at zero is free. Same question, one answer. */
export const isFreeAmount = (amountMinor: bigint): boolean => amountMinor <= 0n;
