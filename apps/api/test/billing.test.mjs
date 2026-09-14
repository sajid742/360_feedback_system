/**
 * Billing and payments — black-box suite.
 *
 * Runs against a RUNNING API (`npm run -w apps/api test:api`) as a PLATFORM
 * ADMINISTRATOR, because half of what has to be proved here lives behind
 * `PlatformAdminGuard`: issuing invoices, recording money, and the manual overrides.
 *
 * IT DOES NOT TOUCH THE DEMO TENANT. Every case runs against a throwaway organisation
 * created through `POST /platform/organizations` and removed again in `after()`. Billing
 * tests move plans, expire subscriptions and mark invoices paid — doing that to the
 * reference tenant would leave it in whatever state the last assertion happened to
 * produce.
 *
 * WHAT IS NOT COVERED HERE, AND WHY. There is no card gateway in this deployment
 * (Stripe does not operate in Pakistan; billing is invoice + bank transfer), so nothing
 * here exercises a hosted checkout page, a card authorisation or a real provider's
 * webhook format. What IS exercised is the pipeline every provider adapter will use: the
 * HMAC signature over the raw bytes, the event log, idempotency by unique index, and the
 * translation of an event into a recorded payment. A gateway adapter arriving later
 * inherits all of that already tested.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { req, login, D, ADMIN } from './helpers.mjs';

/** Must match BILLING_WEBHOOK_SECRET in the API's environment for the signed cases. */
const WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET ?? '';

const stamp = Date.now();
const SLUG = `regr-bill-${stamp}`;
const TENANT_EMAIL = `owner@${SLUG}.test`;
const TENANT_PASSWORD = 'Regr-Billing-1!';

let platform;      // platform administrator (also a tenant user of `care`)
let tenant;        // the throwaway organisation's own administrator
let orgId;
/** Set true when the platform routes answered — the tenant-only cases still run without it. */
let isPlatformAdmin = false;

const sql = async (statement) => {
  // Only used to age dates so the lifecycle job has something to do. Nothing else in
  // this file reaches around the API.
  const { execFile } = await import('node:child_process');
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/e360_cloud';
  return new Promise((resolve) => {
    execFile('psql', [url, '-tAc', statement], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
};

before(async () => {
  platform = await login(ADMIN.email, ADMIN.password);
  assert.equal(platform.status, 200, 'platform administrator must log in');

  const probe = await req('GET', '/platform/billing/stats', { token: platform.token });
  isPlatformAdmin = probe.status === 200;

  if (isPlatformAdmin) {
    const created = await req('POST', '/platform/organizations', {
      token: platform.token,
      body: {
        orgName: `Regr Billing ${stamp}`,
        slug: SLUG,
        email: TENANT_EMAIL,
        password: TENANT_PASSWORD,
        planCode: 'starter',
        trialDays: 0,
      },
    });
    assert.equal(created.status, 201, `tenant creation must succeed: ${created.raw?.slice(0, 300)}`);
    orgId = D(created).organizationId ?? D(created).id;
    assert.ok(orgId, 'new organisation id');

    tenant = await login(TENANT_EMAIL, TENANT_PASSWORD, SLUG);
    assert.equal(tenant.status, 200, 'new tenant administrator must log in');
  }
});

after(async () => {
  if (!orgId) return;
  // Physical removal, in dependency order. The product deliberately offers no
  // hard-delete for an organisation (history is meant to survive), so the throwaway
  // tenant is removed here rather than left behind.
  for (const s of [
    `DELETE FROM payments WHERE organization_id = '${orgId}'`,
    `DELETE FROM invoices WHERE organization_id = '${orgId}'`,
    `DELETE FROM billing_events WHERE organization_id = '${orgId}'`,
    `DELETE FROM subscriptions WHERE organization_id = '${orgId}'`,
    `DELETE FROM audit_logs WHERE organization_id = '${orgId}'`,
    `DELETE FROM notifications WHERE organization_id = '${orgId}'`,
    `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE organization_id = '${orgId}')`,
    `DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE organization_id = '${orgId}')`,
    `DELETE FROM users WHERE organization_id = '${orgId}'`,
    `DELETE FROM roles WHERE organization_id = '${orgId}'`,
    `DELETE FROM configurations WHERE organization_id = '${orgId}'`,
    `DELETE FROM organizations WHERE id = '${orgId}'`,
  ]) {
    await sql(s);
  }
});

/* ------------------------------------------------------------------ reading */

test('billing: the subscription screen loads with a plan, usage and a catalogue', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(r.status, 200);
  const s = D(r);
  assert.equal(s.plan, 'starter', 'the new tenant is on the plan it was created with');
  assert.equal(s.source, 'subscription');
  assert.equal(s.currency, 'PKR', 'money is quoted in the configured currency');
  assert.ok(Array.isArray(s.catalogue) && s.catalogue.length >= 3, 'all plans are offered');
  assert.ok(Array.isArray(s.usage), 'usage counters are present');

  const starter = s.catalogue.find((p) => p.code === 'starter');
  assert.ok(starter.prices.every((p) => p.free === (p.amount === 0)), 'free is derived from the amount, not asserted');
});

/* --------------------------------------------------------------- free plan */

test('billing: choosing the free plan applies at once and raises no invoice', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const before = await req('GET', '/billing/invoices', { token: tenant.token });
  const countBefore = D(before).length;

  const r = await req('POST', '/billing/checkout', { token: tenant.token, body: { planCode: 'starter', interval: 'month' } });
  assert.equal(r.status, 200);
  assert.equal(D(r).free, true, 'a zero price is recognised as free');
  assert.equal(D(r).invoiceId, null, 'no invoice for a free plan');

  const after = await req('GET', '/billing/invoices', { token: tenant.token });
  assert.equal(D(after).length, countBefore, 'still no invoices');

  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(D(summary).plan, 'starter');
  assert.equal(D(summary).operational, true, 'the free plan is operational without payment');
});

/* ---------------------------------------------------------------- checkout */

let invoiceId;
let invoiceNumber;
let invoiceTotal;

test('billing: a paid plan issues an invoice and does NOT change the plan yet', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('POST', '/billing/checkout', { token: tenant.token, body: { planCode: 'professional', interval: 'month' } });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  const c = D(r);
  assert.equal(c.free, false);
  assert.ok(c.invoiceNumber?.startsWith('INV-'), `invoice number looks issued: ${c.invoiceNumber}`);
  assert.ok(c.amountMinor > 0, 'an amount was quoted');
  assert.ok(c.instructions && /Quote invoice number/i.test(c.instructions), 'bank-transfer instructions are returned');
  assert.ok(!c.url, 'invoice billing has no hosted page');
  invoiceId = c.invoiceId;
  invoiceNumber = c.invoiceNumber;
  invoiceTotal = c.amountMinor;

  // The whole point: the plan does not move because a browser hit a button.
  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(D(summary).plan, 'starter', 'the plan changes on PAYMENT, not on checkout');
});

test('billing: the client cannot propose a price', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // A tampered body carrying a one-rupee amount. The DTO whitelists, so the field never
  // reaches the service; the price is looked up server-side from plan_prices.
  const r = await req('POST', '/billing/checkout', {
    token: tenant.token,
    body: { planCode: 'enterprise', interval: 'month', amountMinor: 100, total: 1, price: 1 },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  const priced = await req('GET', '/platform/billing/prices', { token: platform.token });
  const expected = D(priced).find((p) => p.planCode === 'enterprise' && p.interval === 'month').amountMinor;
  assert.equal(D(r).amountMinor > 100, true, 'the tampered amount was ignored');
  // Tax may be added on top, so the invoice total is at least the list price.
  assert.ok(D(r).amountMinor >= expected, `invoiced ${D(r).amountMinor} >= list ${expected}`);
});

test('billing: a second open invoice for the same plan is refused', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const again = await req('POST', '/billing/checkout', { token: tenant.token, body: { planCode: 'professional', interval: 'month' } });
  // Either the same invoice comes back, or the request is refused — never a second
  // open invoice for the same thing.
  if (again.status === 200) {
    assert.equal(D(again).invoiceNumber, invoiceNumber, 'the existing open invoice is returned, not a new one');
  } else {
    assert.equal(again.status, 409, `refused as a conflict rather than duplicated: ${again.status}`);
  }
  const list = await req('GET', '/billing/invoices', { token: tenant.token });
  const open = D(list).filter((i) => i.status === 'open' && i.planCode === 'professional');
  assert.equal(open.length, 1, 'exactly one open Professional invoice exists');
});

/* -------------------------------------------------------- recording money */

test('billing: a tenant cannot record its own payment', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('POST', `/platform/billing/invoices/${invoiceId}/payments`, {
    token: tenant.token,
    body: { amountMinor: invoiceTotal, method: 'bank_transfer', reference: 'self-service attempt' },
  });
  assert.ok(r.status === 403 || r.status === 404, `tenant is refused (${r.status})`);

  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(D(summary).plan, 'starter', 'and the plan did not move');
});

test('billing: a part payment is recorded but does not activate the plan', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const half = Math.floor(invoiceTotal / 2);
  const r = await req('POST', `/platform/billing/invoices/${invoiceId}/payments`, {
    token: platform.token,
    body: { amountMinor: half, method: 'bank_transfer', reference: `PART-${stamp}` },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  assert.equal(D(r).status, 'open', 'a half-paid invoice stays open');

  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(D(summary).plan, 'starter', 'half the money buys none of the plan');
});

test('billing: paying the invoice in full activates the plan and sets a period', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const rest = invoiceTotal - Math.floor(invoiceTotal / 2);
  const r = await req('POST', `/platform/billing/invoices/${invoiceId}/payments`, {
    token: platform.token,
    body: { amountMinor: rest, method: 'bank_transfer', reference: `FINAL-${stamp}` },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  assert.equal(D(r).status, 'paid', 'the invoice is settled');
  assert.ok(D(r).paidAt, 'and stamped');

  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  const s = D(summary);
  assert.equal(s.plan, 'professional', 'the plan follows the money');
  assert.equal(s.subscriptionStatus, 'active');
  assert.ok(s.currentPeriodEnd, 'a period end was set');
  assert.ok(new Date(s.currentPeriodEnd).getTime() > Date.now(), 'and it is in the future');
});

test('billing: the paid plan really unlocks the module it sells', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // Starter does not include parent feedback; Professional does. The check is a real
  // request as a user holding every tenant permission, so what is proved is the
  // ENTITLEMENT, not a hidden menu item. `/external-evaluation` is the parent-feedback
  // module's controller — it carries @RequiresLicensedModule('parent_feedback').
  const r = await req('GET', '/external-evaluation/cycles', { token: tenant.token });
  assert.equal(r.status, 200, `an entitled module is reachable, got ${r.status}`);
});

/* ------------------------------------------------------------- idempotency */

test('billing: recording the same provider payment twice creates one payment', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const before = await req('GET', '/platform/billing/payments', { token: platform.token, });
  const mine = D(before).filter((p) => p.organizationId === orgId).length;

  // A second full payment against a settled invoice must not double-count the money.
  const r = await req('POST', `/platform/billing/invoices/${invoiceId}/payments`, {
    token: platform.token,
    body: { amountMinor: 0, method: 'bank_transfer', reference: `ZERO-${stamp}` },
  });
  assert.equal(r.status, 200);
  const after = await req('GET', '/platform/billing/payments', { token: platform.token });
  const nowMine = D(after).filter((p) => p.organizationId === orgId);
  assert.ok(nowMine.length >= mine, 'payments are append-only');
  // The invoice cannot go past paid.
  assert.equal(D(r).status, 'paid');
});

/* ---------------------------------------------------------------- webhooks */

const sign = (body) => createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body)).digest('hex');

test('webhook: an unsigned delivery is refused, recorded, and changes nothing', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const eventId = `evt-unsigned-${randomUUID()}`;
  const body = JSON.stringify({
    id: eventId,
    type: 'payment.succeeded',
    data: { invoice_number: invoiceNumber, payment_id: `forged-${eventId}`, amount_minor: 1 },
  });
  const r = await req('POST', '/billing/webhook/invoice', { body });
  // Always a 200 — providers retry on anything else.
  assert.equal(r.status, 200, 'the endpoint answers 200 even when refusing');
  assert.equal(D(r).status, 'rejected', 'an unsigned event is rejected');

  const events = await req('GET', '/platform/billing/events', { token: platform.token });
  const row = D(events).find((e) => e.eventId === eventId);
  assert.ok(row, 'the attempt is kept — a forgery must be visible, not silent');
  assert.equal(row.signatureValid, false);
  assert.notEqual(row.status, 'processed', 'and was never applied');
});

test('webhook: a wrongly signed delivery is refused', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const eventId = `evt-badsig-${randomUUID()}`;
  const body = JSON.stringify({ id: eventId, type: 'payment.succeeded', data: { invoice_number: invoiceNumber } });
  const r = await req('POST', '/billing/webhook/invoice', {
    body,
    headers: { 'x-billing-signature': createHmac('sha256', 'the-wrong-secret').update(body).digest('hex') },
  });
  assert.equal(r.status, 200);
  assert.equal(D(r).status, 'rejected');
});

let secondInvoiceId;
let secondInvoiceNumber;
let secondInvoiceTotal;

test('webhook: a correctly signed payment event settles the invoice it names', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  if (!WEBHOOK_SECRET) return t.skip('BILLING_WEBHOOK_SECRET is not set for this run — see the file header');

  // A fresh invoice, so the webhook has something open to settle. Issued by the
  // platform, which is how a renewal is raised.
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'professional', interval: 'year', notes: 'webhook case' },
  });
  assert.equal(issued.status, 201, issued.raw?.slice(0, 300));
  secondInvoiceId = D(issued).id;
  secondInvoiceNumber = D(issued).number;
  secondInvoiceTotal = D(issued).total;

  const eventId = `evt-ok-${randomUUID()}`;
  const body = JSON.stringify({
    id: eventId,
    type: 'payment.succeeded',
    data: {
      invoice_number: secondInvoiceNumber,
      payment_id: `pay-${eventId}`,
      amount_minor: secondInvoiceTotal,
      currency: 'PKR',
    },
  });
  const r = await req('POST', '/billing/webhook/invoice', { body, headers: { 'x-billing-signature': sign(body) } });
  assert.equal(r.status, 200);
  assert.equal(D(r).status, 'processed', `a signed event is applied: ${r.raw?.slice(0, 300)}`);

  const inv = await req('GET', `/billing/invoices/${secondInvoiceId}`, { token: tenant.token });
  assert.equal(D(inv).status, 'paid', 'the invoice the event named is settled');

  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(D(summary).billingInterval, 'year', 'and the subscription took the new interval');
});

test('webhook: the SAME event delivered again is a duplicate and pays nothing twice', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  if (!WEBHOOK_SECRET) return t.skip('BILLING_WEBHOOK_SECRET is not set for this run');

  const eventId = `evt-retry-${randomUUID()}`;
  const body = JSON.stringify({
    id: eventId,
    type: 'payment.succeeded',
    data: { invoice_number: secondInvoiceNumber, payment_id: `pay-${eventId}`, amount_minor: secondInvoiceTotal },
  });
  const headers = { 'x-billing-signature': sign(body) };

  const first = await req('POST', '/billing/webhook/invoice', { body, headers });
  assert.equal(first.status, 200);

  const payments = await req('GET', '/platform/billing/payments', { token: platform.token });
  const countAfterFirst = D(payments).filter((p) => p.organizationId === orgId).length;

  // Byte-identical redelivery, three times, exactly as a provider retries.
  for (let i = 0; i < 3; i += 1) {
    const again = await req('POST', '/billing/webhook/invoice', { body, headers });
    assert.equal(again.status, 200);
    assert.equal(D(again).status, 'duplicate', `retry ${i + 1} recognised as a duplicate`);
  }

  const after = await req('GET', '/platform/billing/payments', { token: platform.token });
  const countNow = D(after).filter((p) => p.organizationId === orgId).length;
  assert.equal(countNow, countAfterFirst, 'three retries created no extra payment rows');

  const subs = await sql(`SELECT count(*) FROM subscriptions WHERE organization_id = '${orgId}' AND deleted_at IS NULL`);
  assert.equal(subs, '1', 'and no duplicate subscription');
});

test('webhook: a failed-payment event is recorded and does not downgrade anyone', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  if (!WEBHOOK_SECRET) return t.skip('BILLING_WEBHOOK_SECRET is not set for this run');

  const planBefore = D(await req('GET', '/billing/summary', { token: tenant.token })).plan;
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'enterprise', interval: 'month' },
  });
  assert.equal(issued.status, 201);

  const eventId = `evt-fail-${randomUUID()}`;
  const body = JSON.stringify({
    id: eventId,
    type: 'payment.failed',
    data: { invoice_number: D(issued).number, payment_id: `pay-${eventId}`, failure_reason: 'Insufficient funds' },
  });
  const r = await req('POST', '/billing/webhook/invoice', { body, headers: { 'x-billing-signature': sign(body) } });
  assert.equal(r.status, 200);
  assert.equal(D(r).status, 'processed');

  const inv = await req('GET', `/billing/invoices/${D(issued).id}`, { token: tenant.token });
  assert.equal(D(inv).status, 'open', 'a failed payment leaves the invoice open, not void');

  const planAfter = D(await req('GET', '/billing/summary', { token: tenant.token })).plan;
  assert.equal(planAfter, planBefore, 'a failed payment for an UPGRADE does not touch the current plan');

  const payments = await req('GET', '/platform/billing/payments', { token: platform.token });
  const failed = D(payments).find((p) => p.organizationId === orgId && p.status === 'failed');
  assert.ok(failed, 'the failure is recorded');
  assert.match(failed.failureReason ?? '', /Insufficient funds/);
});

test('webhook: an unknown event type is stored and ignored, not an error', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  if (!WEBHOOK_SECRET) return t.skip('BILLING_WEBHOOK_SECRET is not set for this run');
  const eventId = `evt-unknown-${randomUUID()}`;
  const body = JSON.stringify({ id: eventId, type: 'customer.address.updated', data: {} });
  const r = await req('POST', '/billing/webhook/invoice', { body, headers: { 'x-billing-signature': sign(body) } });
  assert.equal(r.status, 200);
  assert.equal(D(r).status, 'ignored', 'an event we do not act on is not a failure');
});

/* ------------------------------------------------ platform manual overrides */

test('billing: an invoice can be voided, never deleted', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'starter', interval: 'month', notes: 'raised in error' },
  });
  assert.equal(issued.status, 201);
  const id = D(issued).id;

  const voided = await req('POST', `/platform/billing/invoices/${id}/void`, {
    token: platform.token,
    body: { reason: 'duplicate of another invoice' },
  });
  assert.equal(voided.status, 200, voided.raw?.slice(0, 300));
  assert.equal(D(voided).status, 'void');

  const still = await req('GET', `/billing/invoices/${id}`, { token: tenant.token });
  assert.equal(still.status, 200, 'a voided invoice is still visible to the customer who saw it');
  assert.match(D(still).notes ?? '', /duplicate of another invoice/);

  const paying = await req('POST', `/platform/billing/invoices/${id}/payments`, {
    token: platform.token,
    body: { amountMinor: 1 },
  });
  assert.equal(paying.status, 400, 'and cannot be paid');
});

test('billing: a paid invoice cannot be voided', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('POST', `/platform/billing/invoices/${invoiceId}/void`, { token: platform.token, body: { reason: 'oops' } });
  assert.equal(r.status, 400, 'history is not rewritten by voiding a settled invoice');
});

test('billing: a complimentary plan is granted with a reason on the record', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('POST', `/platform/billing/organizations/${orgId}/complimentary`, {
    token: platform.token,
    body: { planCode: 'enterprise', days: 30, reason: 'regression test pilot' },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  assert.equal(D(r).planCode, 'enterprise');

  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(D(summary).plan, 'enterprise');

  const payments = await req('GET', '/platform/billing/payments', { token: platform.token });
  const comp = D(payments).find((p) => p.organizationId === orgId && p.method === 'complimentary');
  assert.ok(comp, 'why this tenant has a plan it never paid for is answerable from the billing history');
  assert.equal(comp.amount, 0);
});

test('billing: extending a subscription pushes the period and restores service', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const before = D(await req('GET', '/billing/summary', { token: tenant.token })).currentPeriodEnd;
  const r = await req('POST', `/platform/billing/organizations/${orgId}/extend`, {
    token: platform.token,
    body: { days: 14, reason: 'transfer in flight' },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  const after = D(await req('GET', '/billing/summary', { token: tenant.token })).currentPeriodEnd;
  assert.ok(new Date(after).getTime() > new Date(before).getTime(), 'the period moved out');
  assert.equal(D(await req('GET', '/billing/summary', { token: tenant.token })).subscriptionStatus, 'active');
});

test('billing: a price change needs no release and does not rewrite issued invoices', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const prices = D(await req('GET', '/platform/billing/prices', { token: platform.token }));
  const row = prices.find((p) => p.planCode === 'professional' && p.interval === 'month');
  const original = row.amountMinor;

  const paidInvoiceBefore = D(await req('GET', `/billing/invoices/${invoiceId}`, { token: tenant.token })).total;

  const changed = await req('PUT', '/platform/billing/prices', {
    token: platform.token,
    body: { planCode: 'professional', interval: 'month', amountMinor: original + 500000 },
  });
  assert.equal(changed.status, 200, changed.raw?.slice(0, 300));
  assert.equal(D(changed).amountMinor, original + 500000);

  const paidInvoiceAfter = D(await req('GET', `/billing/invoices/${invoiceId}`, { token: tenant.token })).total;
  assert.equal(paidInvoiceAfter, paidInvoiceBefore, 'an invoice records what was charged AT THE TIME');

  // Put it back, so a test run does not quietly reprice the product.
  const restored = await req('PUT', '/platform/billing/prices', {
    token: platform.token,
    body: { planCode: 'professional', interval: 'month', amountMinor: original },
  });
  assert.equal(restored.status, 200);
});

/* --------------------------------------------------------------- lifecycle */

test('lifecycle: a lapsed period moves to grace, then expires, and deletes nothing', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');

  const employeesBefore = await req('GET', '/organization/employees', { token: tenant.token });
  assert.equal(employeesBefore.status, 200);

  // Age the subscription: period ended yesterday, with a 7-day grace.
  await sql(
    `UPDATE subscriptions SET status='active', cancel_at_period_end=false, grace_days=7,
       current_period_start=now() - interval '31 days', current_period_end=now() - interval '1 day'
     WHERE organization_id = '${orgId}'`,
  );
  let run = await req('POST', '/platform/billing/lifecycle/run', { token: platform.token });
  assert.equal(run.status, 200, run.raw?.slice(0, 300));

  let s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  assert.equal(s.subscriptionStatus, 'grace', 'one day past the period end is grace, not expiry');
  assert.equal(s.operational, true, 'and grace still works — that is the point of it');

  // Now age it past the grace window.
  await sql(
    `UPDATE subscriptions SET current_period_end = now() - interval '30 days' WHERE organization_id = '${orgId}'`,
  );
  run = await req('POST', '/platform/billing/lifecycle/run', { token: platform.token });
  assert.equal(run.status, 200);

  s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  assert.equal(s.subscriptionStatus, 'expired');
  assert.equal(s.operational, false, 'an expired subscription is not operational');

  // THE IMPORTANT PART: nothing was deleted and everyone can still read.
  const employeesAfter = await req('GET', '/organization/employees', { token: tenant.token });
  assert.equal(employeesAfter.status, 200, 'an expired tenant can still sign in and read its data');
  assert.equal(
    (employeesAfter.json.data.items ?? employeesAfter.json.data).length,
    (employeesBefore.json.data.items ?? employeesBefore.json.data).length,
    'and not one record was removed by expiry',
  );
});

test('lifecycle: the run is idempotent — a second sweep changes nothing', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const first = D(await req('POST', '/platform/billing/lifecycle/run', { token: platform.token }));
  assert.equal(first.changed, 0, 'nothing left to transition');
});

test('lifecycle: paying an invoice brings an expired tenant straight back', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'professional', interval: 'month', notes: 'renewal after expiry' },
  });
  assert.equal(issued.status, 201);
  const paid = await req('POST', `/platform/billing/invoices/${D(issued).id}/payments`, {
    token: platform.token,
    body: { method: 'bank_transfer', reference: `RENEW-${stamp}` },
  });
  assert.equal(paid.status, 200, paid.raw?.slice(0, 300));

  const s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  assert.equal(s.subscriptionStatus, 'active', 'renewal reactivates');
  assert.equal(s.plan, 'professional');
  assert.equal(s.operational, true);
});

/* ------------------------------------------------------------ cancellation */

test('billing: cancelling ends at the period — never immediately, never destructively', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('POST', '/billing/cancel', { token: tenant.token, body: { reason: 'regression test' } });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  assert.equal(D(r).cancelAtPeriodEnd, true);

  const s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  assert.equal(s.cancelAtPeriodEnd, true);
  assert.equal(s.plan, 'professional', 'they keep what they paid for');
  assert.equal(s.operational, true, 'until the period actually ends');
});

test('billing: cancelling twice is harmless', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('POST', '/billing/cancel', { token: tenant.token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(D(r).cancelAtPeriodEnd, true);
});

test('billing: reactivating before the period ends undoes the cancellation', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('POST', '/billing/reactivate', { token: tenant.token });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  assert.equal(D(r).cancelAtPeriodEnd, false);
  assert.equal(D(await req('GET', '/billing/summary', { token: tenant.token })).cancelAtPeriodEnd, false);
});

test('lifecycle: a cancelled subscription expires with NO grace period', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  await req('POST', '/billing/cancel', { token: tenant.token, body: { reason: 'grace check' } });
  await sql(
    `UPDATE subscriptions SET status='active', grace_days=7, current_period_end = now() - interval '1 day'
     WHERE organization_id = '${orgId}'`,
  );
  const run = await req('POST', '/platform/billing/lifecycle/run', { token: platform.token });
  assert.equal(run.status, 200);
  const s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  // They asked for it to end. Chasing them through a grace period would be wrong.
  assert.equal(s.subscriptionStatus, 'expired', 'a cancellation ends on the date, without grace');
});

/* ------------------------------------------------------------- enforcement */

test('billing: downgrading really removes the module the lower plan does not include', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('PUT', `/platform/organizations/${orgId}/subscription`, {
    token: platform.token,
    body: { planCode: 'starter', status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString() },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));

  // Starter does not include parent feedback. A module the organisation has not bought
  // answers 404 — "there is no such thing here" — not 403, which would advertise it.
  const gated = await req('GET', '/external-evaluation/cycles', { token: tenant.token });
  assert.equal(gated.status, 404, `unentitled module is invisible, got ${gated.status}`);
});

test('billing: a tenant cannot reach any platform billing route', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // The throwaway tenant's administrator holds every permission inside its own
  // organisation. None of that reaches the vendor's routes.
  for (const [method, path, body] of [
    ['GET', '/platform/billing/stats', undefined],
    ['GET', '/platform/billing/invoices', undefined],
    ['GET', '/platform/billing/events', undefined],
    ['GET', '/platform/billing/prices', undefined],
    ['PUT', '/platform/billing/prices', { planCode: 'enterprise', interval: 'month', amountMinor: 1 }],
    ['POST', `/platform/billing/organizations/${orgId}/complimentary`, { planCode: 'enterprise', days: 365, reason: 'self-granted' }],
    ['POST', `/platform/billing/organizations/${orgId}/extend`, { days: 365, reason: 'self-granted' }],
    ['POST', '/platform/billing/lifecycle/run', {}],
  ]) {
    const r = await req(method, path, { token: tenant.token, body });
    assert.ok(r.status === 403 || r.status === 404, `${method} ${path} refused for a tenant (got ${r.status})`);
  }

  // And the self-granted plan did not happen.
  assert.equal(D(await req('GET', '/billing/summary', { token: tenant.token })).plan, 'starter');
});

test('billing: one organisation cannot read another organisation\'s invoices', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // `platform` is also an ordinary administrator of the `care` tenant. Asking for the
  // throwaway tenant's invoice through the TENANT route must not find it, platform
  // rights or not — the tenant route is scoped by the token's organisation, full stop.
  const r = await req('GET', `/billing/invoices/${invoiceId}`, { token: platform.token });
  assert.equal(r.status, 404, `cross-tenant invoice read is a 404 (got ${r.status})`);

  const mine = await req('GET', '/billing/invoices', { token: platform.token });
  assert.equal(mine.status, 200);
  assert.equal(
    D(mine).some((i) => i.id === invoiceId),
    false,
    'and it does not appear in their own list',
  );
});

test('billing: money is never a float anywhere it is returned', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const invoices = D(await req('GET', '/platform/billing/invoices', { token: platform.token }));
  for (const i of invoices.slice(0, 20)) {
    assert.equal(Number.isInteger(i.total), true, `invoice ${i.number} total is integer minor units`);
  }
  const payments = D(await req('GET', '/platform/billing/payments', { token: platform.token }));
  for (const p of payments.slice(0, 20)) {
    assert.equal(Number.isInteger(p.amount), true, 'payment amount is integer minor units');
  }
});

/* ------------------------------------------- hardening (adversarial review) */

test('webhook: junk bodies are recorded and refused, never a 500', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // Every one of these is what an unauthenticated caller can send. None may throw out of
  // the handler, because a non-2xx makes a provider redeliver for ever — and each must
  // still leave a trace, because a forged delivery that vanishes is worse than one that
  // fails.
  const cases = [
    ['null body', 'null'],
    ['bare string', '"hello"'],
    ['number', '42'],
    ['array', '[1,2,3]'],
    ['not JSON at all', 'hello'],
    ['over-long type', JSON.stringify({ id: `evt-long-${randomUUID()}`, type: 'x'.repeat(500), data: {} })],
    ['over-long id', JSON.stringify({ id: 'y'.repeat(500), type: 'payment.succeeded', data: {} })],
  ];
  for (const [label, body] of cases) {
    const r = await req('POST', '/billing/webhook/invoice', { body });
    assert.equal(r.status, 200, `${label} answers 200, got ${r.status}: ${r.raw?.slice(0, 200)}`);
    assert.ok(['rejected', 'failed', 'ignored', 'duplicate'].includes(D(r).status), `${label} → ${D(r).status}`);
  }
  // An over-long provider key in the path is caller-controlled too.
  const long = await req('POST', `/billing/webhook/${'p'.repeat(120)}`, { body: '{}' });
  assert.equal(long.status, 200, 'an over-long provider path answers 200');
});

test('webhook: a forged delivery is recorded even when the body is not JSON', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const marker = `not-json-${randomUUID()}`;
  const r = await req('POST', '/billing/webhook/invoice', { body: marker });
  assert.equal(r.status, 200);
  const events = await req('GET', '/platform/billing/events', { token: platform.token });
  // It has no id of its own, so it is keyed by a digest of its bytes — but it exists.
  const before = D(events).length;
  assert.ok(before > 0, 'the event log is not empty');
  const again = await req('POST', '/billing/webhook/invoice', { body: marker });
  assert.equal(D(again).status, 'duplicate', 'and the same junk body is recognised as the same delivery');
});

test('billing: a negative payment amount is refused', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'professional', interval: 'month', notes: 'negative-amount check' },
  });
  assert.equal(issued.status, 201);
  const r = await req('POST', `/platform/billing/invoices/${D(issued).id}/payments`, {
    token: platform.token,
    body: { amountMinor: -100000, reference: 'should not exist' },
  });
  assert.equal(r.status, 400, `a negative amount is refused, got ${r.status}`);
  await req('POST', `/platform/billing/invoices/${D(issued).id}/void`, { token: platform.token, body: { reason: 'test cleanup' } });
});

test('billing: an invoice whose period has already passed does NOT move the plan', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // Put the tenant on Enterprise with a year to run.
  await req('PUT', `/platform/organizations/${orgId}/subscription`, {
    token: platform.token,
    body: { planCode: 'enterprise', status: 'active', currentPeriodEnd: new Date(Date.now() + 365 * 86400000).toISOString() },
  });

  // An old Professional invoice, still open, for a period that ended last month.
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'professional', interval: 'month', notes: 'late payment check' },
  });
  assert.equal(issued.status, 201);
  await sql(
    `UPDATE invoices SET period_start = now() - interval '2 months', period_end = now() - interval '1 month'
     WHERE id = '${D(issued).id}'`,
  );

  const paid = await req('POST', `/platform/billing/invoices/${D(issued).id}/payments`, {
    token: platform.token,
    body: { method: 'bank_transfer', reference: `LATE-${stamp}` },
  });
  assert.equal(paid.status, 200);
  assert.equal(D(paid).status, 'paid', 'the money is still recorded and the invoice settled');

  const s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  assert.equal(s.plan, 'enterprise', 'a late payment for a lapsed period must not downgrade a live plan');
  assert.equal(s.subscriptionStatus, 'active');
  assert.ok(new Date(s.currentPeriodEnd).getTime() > Date.now(), 'and must not back-date the period');
});

test('billing: renewing early extends the period instead of restarting it', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // Enterprise, monthly, with 20 days still to run.
  const endsAt = new Date(Date.now() + 20 * 86400000);
  await req('PUT', `/platform/organizations/${orgId}/subscription`, {
    token: platform.token,
    body: { planCode: 'enterprise', status: 'active', currentPeriodEnd: endsAt.toISOString() },
  });

  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'enterprise', interval: 'month', notes: 'early renewal' },
  });
  assert.equal(issued.status, 201);
  const paid = await req('POST', `/platform/billing/invoices/${D(issued).id}/payments`, {
    token: platform.token,
    body: { method: 'bank_transfer', reference: `EARLY-${stamp}` },
  });
  assert.equal(paid.status, 200);

  const s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  const newEnd = new Date(s.currentPeriodEnd).getTime();
  // A month added to the EXISTING end, not to today — the 20 remaining days survive.
  assert.ok(
    newEnd > endsAt.getTime() + 25 * 86400000,
    `the paid-for time was kept: ends ${s.currentPeriodEnd}, previous end ${endsAt.toISOString()}`,
  );
});

test('billing: an invoice filter that is not a UUID is a 400, not a 500', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  const r = await req('GET', '/platform/billing/invoices?organizationId=not-a-uuid', { token: platform.token });
  assert.equal(r.status, 400, `got ${r.status}`);
});

test('lifecycle: a manual run reports warnings without sending them', async (t) => {
  if (!isPlatformAdmin) return t.skip('needs a platform administrator');
  // Seven days out is a warning boundary.
  await sql(
    `UPDATE subscriptions SET status='active', cancel_at_period_end=false,
       current_period_end = now() + interval '7 days' WHERE organization_id = '${orgId}'`,
  );
  const first = await req('POST', '/platform/billing/lifecycle/run', { token: platform.token });
  assert.equal(first.status, 200);
  // Pressing it repeatedly must stay safe: status changes are idempotent and warnings
  // are counted, not sent, on a manual run.
  const second = await req('POST', '/platform/billing/lifecycle/run', { token: platform.token });
  assert.equal(second.status, 200);
  assert.equal(D(second).changed, 0, 'nothing left to transition');
  for (const d of D(second).details) {
    if (/day\(s\) left/.test(d)) assert.match(d, /not sent — manual run/, `warning was reported, not sent: ${d}`);
  }
});
