import { apiClient } from '@/lib/api-client';
import type { EntitlementLimits, LimitUsage } from '@/features/license/useEntitlements';

/**
 * The tenant's billing surface.
 *
 * NOTE WHAT `checkout` SENDS: a plan code and an interval, and nothing else. The price
 * is looked up on the server from `plan_prices`, so there is deliberately no field here
 * in which this screen could propose an amount — a tampered request has nothing to
 * tamper with.
 */

export interface InvoiceView {
  id: string;
  number: string;
  planCode: string;
  interval: string;
  currency: string;
  /** All amounts are integer MINOR units (paisa). Never a float, never a display string. */
  subtotal: number;
  tax: number;
  total: number;
  totalFormatted: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  notes: string | null;
}

export interface PaymentView {
  id: string;
  invoiceNumber: string | null;
  provider: string;
  method: string;
  status: string;
  amount: number;
  amountFormatted: string;
  reference: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface PlanPriceView {
  interval: 'month' | 'year';
  amount: number;
  formatted: string;
  free: boolean;
}

export interface PlanOffer {
  code: string;
  label: string;
  blurb: string;
  modules: string[];
  limits: EntitlementLimits;
  prices: PlanPriceView[];
}

export interface BillingSummary {
  plan: string | null;
  planLabel: string | null;
  source: 'subscription' | 'license' | 'development' | 'none';
  status: string;
  subscriptionStatus: string | null;
  operational: boolean;
  /** Written for an administrator already — display it, do not re-word it. */
  message: string;
  billingInterval: 'month' | 'year';
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceDays: number | null;
  currency: string;
  taxPercent: number;
  usage: LimitUsage[];
  invoices: InvoiceView[];
  payments: PaymentView[];
  catalogue: PlanOffer[];
}

export interface CheckoutResponse {
  /** null on the free plan: nothing was invoiced. */
  invoiceId: string | null;
  invoiceNumber: string | null;
  amountMinor: number;
  currency: string;
  /** A hosted-gateway provider returns a page to visit… */
  url?: string;
  /** …invoice billing returns what to pay and how. */
  instructions?: string;
  free: boolean;
}

export const billingApi = {
  summary: (): Promise<BillingSummary> => apiClient.get('/billing/summary'),
  invoices: (): Promise<InvoiceView[]> => apiClient.get('/billing/invoices'),
  checkout: (planCode: string, interval: 'month' | 'year'): Promise<CheckoutResponse> =>
    apiClient.post('/billing/checkout', { planCode, interval }),
  cancel: (reason?: string): Promise<{ cancelAtPeriodEnd: boolean; endsAt: string | null }> =>
    apiClient.post('/billing/cancel', { reason }),
  reactivate: (): Promise<{ cancelAtPeriodEnd: boolean }> => apiClient.post('/billing/reactivate', {}),
};
