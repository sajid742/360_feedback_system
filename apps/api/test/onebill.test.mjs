/**
 * 1BILL (1LINK) billing-partner adapter — black-box suite.
 *
 * HOW TO RUN IT. This suite only does anything when the API is configured for 1BILL,
 * because it exercises the adapter that is actually issuing bills. Start the API with:
 *
 *   BILLING_PROVIDER=1bill \
 *   ONEBILL_BASE_URL=http://127.0.0.1:3999 \
 *   ONEBILL_PREFIX=4471 \
 *   ONEBILL_API_KEY=test-key \
 *   ONEBILL_WEBHOOK_SECRET=<same value the test uses> \
 *   ONEBILL_TIMEOUT_MS=3000
 *
 * then `node --test test/onebill.test.mjs`. Against an API running on invoice billing
 * every case skips with a reason rather than failing, so the default `npm run test:api`
 * stays green and honest.
 *
 * WHAT IT PROVES: that a bill is registered with the partner, that the partner's own
 * consumer number is stored and shown, that a signed callback settles the invoice and
 * applies the plan, that a redelivered callback changes nothing, that a LOST callback is
 * recovered by reconciliation, and that a partner outage or hang never costs the customer
 * their invoice.
 *
 * WHAT IT CANNOT PROVE: the partner's real field names. It answers in the shape the
 * adapter currently expects, which is a documented guess. See the header of
 * `onebill.provider.ts`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { req, login, D, ADMIN } from './helpers.mjs';
import { startSimulator } from './onebill-simulator.mjs';

const SECRET = process.env.ONEBILL_WEBHOOK_SECRET ?? '';
const SIM_PORT = Number(process.env.ONEBILL_SIM_PORT ?? 3999);

const stamp = Date.now();
const SLUG = `regr-1bill-${stamp}`;
const TENANT_EMAIL = `owner@${SLUG}.test`;
const TENANT_PASSWORD = 'Regr-OneBill-1!';

let platform;
let tenant;
let orgId;
let sim;
/** Why the suite is not running, when it is not. */
let skipReason = null;

const sql = async (statement) => {
  const { execFile } = await import('node:child_process');
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/e360_cloud';
  return new Promise((resolve) => {
    execFile('psql', [url, '-tAc', statement], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
};

const sign = (body) => createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');

/** Talk to the simulator's test-only side channel. */
const control = async (path, method = 'POST', body) => {
  const res = await fetch(`http://127.0.0.1:${SIM_PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({}));
};

before(async () => {
  platform = await login(ADMIN.email, ADMIN.password);
  if (platform.status !== 200) {
    skipReason = 'the platform administrator could not sign in';
    return;
  }

  const probe = await req('GET', '/platform/billing/providers', { token: platform.token });
  if (probe.status !== 200) {
    skipReason = `this account is not a platform administrator (${probe.status})`;
    return;
  }
  if (D(probe).active !== '1bill') {
    skipReason = `the API is running on the "${D(probe).active}" provider — see this file's header`;
    return;
  }
  if (!SECRET) {
    skipReason = 'ONEBILL_WEBHOOK_SECRET is not set for this test run';
    return;
  }

  sim = await startSimulator(SIM_PORT);

  const created = await req('POST', '/platform/organizations', {
    token: platform.token,
    body: {
      orgName: `Regr 1BILL ${stamp}`,
      slug: SLUG,
      email: TENANT_EMAIL,
      password: TENANT_PASSWORD,
      planCode: 'starter',
      trialDays: 0,
    },
  });
  assert.equal(created.status, 201, `tenant creation must succeed: ${created.raw?.slice(0, 300)}`);
  orgId = D(created).organizationId ?? D(created).id;
  tenant = await login(TENANT_EMAIL, TENANT_PASSWORD, SLUG);
  assert.equal(tenant.status, 200, 'the new tenant administrator must log in');
});

after(async () => {
  if (sim) await sim.close();
  if (!orgId) return;
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
  // Leave no 1BILL billing_events behind for the next run to trip over.
  await sql(`DELETE FROM billing_events WHERE provider = '1bill' AND organization_id IS NULL`);
});

/* ----------------------------------------------------------------- checkout */

let invoiceId;
let invoiceNumber;
let consumerNumber;

test('1bill: choosing a paid plan registers a bill with the partner', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const r = await req('POST', '/billing/checkout', {
    token: tenant.token,
    body: { planCode: 'professional', interval: 'month' },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  const c = D(r);
  invoiceId = c.invoiceId;
  invoiceNumber = c.invoiceNumber;

  assert.equal(c.free, false);
  assert.ok(!c.url, '1BILL has no hosted page to send anyone to');
  assert.match(c.instructions, /1BILL ID:/, 'the customer is given an ID to quote');
  assert.match(c.instructions, /ATM|branch|mobile app/i, 'and told where they can pay it');

  // The partner really was called, and the bill it holds matches the invoice.
  const held = await control('/_control/bills', 'GET');
  const bill = held.bills.find((b) => b.bill_reference === invoiceNumber);
  assert.ok(bill, `the partner holds a bill for ${invoiceNumber}`);
  assert.equal(bill.amount_minor, c.amountMinor, 'for the amount the invoice says');
  assert.equal(bill.currency, c.currency);
  assert.ok(bill.due_date, 'with a due date');
  consumerNumber = bill.consumer_number;
});

test('1bill: the PARTNER\'S consumer number is stored, not our guess', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // The simulator deliberately assigns a number different from the one sent, because a
  // real partner does. Storing our own guess would hand the customer an ID no bank knows.
  const stored = await sql(`SELECT provider_invoice_id FROM invoices WHERE id = '${invoiceId}'`);
  assert.equal(stored, consumerNumber, 'the invoice carries the number the partner assigned');

  const provider = await sql(`SELECT provider FROM invoices WHERE id = '${invoiceId}'`);
  assert.equal(provider, '1bill', 'and is marked as the provider that issued it');

  const summary = await req('GET', '/billing/summary', { token: tenant.token });
  assert.equal(D(summary).plan, 'starter', 'registering a bill does not buy the plan');
});

/* ----------------------------------------------------------------- callback */

test('1bill: a signed paid callback settles the invoice and applies the plan', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const eventId = `1b-evt-${randomUUID()}`;
  const body = JSON.stringify({
    event_id: eventId,
    event: 'bill.paid',
    data: {
      consumer_number: consumerNumber,
      bill_reference: invoiceNumber,
      transaction_id: `TXN-${eventId}`,
      amount_minor: D(await req('GET', `/billing/invoices/${invoiceId}`, { token: tenant.token })).total,
      currency: 'PKR',
      status: 'PAID',
      response_code: '00',
    },
  });

  const r = await req('POST', '/billing/webhook/1bill', { body, headers: { 'x-onebill-signature': sign(body) } });
  assert.equal(r.status, 200);
  assert.equal(D(r).status, 'processed', `the callback was applied: ${r.raw?.slice(0, 300)}`);

  const inv = await req('GET', `/billing/invoices/${invoiceId}`, { token: tenant.token });
  assert.equal(D(inv).status, 'paid');

  const s = D(await req('GET', '/billing/summary', { token: tenant.token }));
  assert.equal(s.plan, 'professional', 'the plan follows the money');
  assert.equal(s.subscriptionStatus, 'active');
  assert.ok(new Date(s.currentPeriodEnd).getTime() > Date.now());
});

test('1bill: the same callback redelivered changes nothing', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const eventId = `1b-retry-${randomUUID()}`;
  const body = JSON.stringify({
    event_id: eventId,
    event: 'bill.paid',
    data: { consumer_number: consumerNumber, bill_reference: invoiceNumber, transaction_id: `TXN-${eventId}`, amount_minor: 1 },
  });
  const headers = { 'x-onebill-signature': sign(body) };

  await req('POST', '/billing/webhook/1bill', { body, headers });
  const payments = D(await req('GET', '/platform/billing/payments', { token: platform.token }));
  const before = payments.filter((p) => p.organizationId === orgId).length;

  for (let i = 0; i < 3; i += 1) {
    const again = await req('POST', '/billing/webhook/1bill', { body, headers });
    assert.equal(again.status, 200);
    assert.equal(D(again).status, 'duplicate', `retry ${i + 1} is a duplicate`);
  }

  const after = D(await req('GET', '/platform/billing/payments', { token: platform.token }));
  assert.equal(after.filter((p) => p.organizationId === orgId).length, before, 'no extra payment rows');
  assert.equal(await sql(`SELECT count(*) FROM subscriptions WHERE organization_id = '${orgId}' AND deleted_at IS NULL`), '1');
});

test('1bill: a callback signed with the wrong secret is refused and recorded', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const eventId = `1b-forged-${randomUUID()}`;
  const body = JSON.stringify({ event_id: eventId, event: 'bill.paid', data: { bill_reference: invoiceNumber } });
  const r = await req('POST', '/billing/webhook/1bill', {
    body,
    headers: { 'x-onebill-signature': createHmac('sha256', 'not-the-secret').update(body).digest('hex') },
  });
  assert.equal(r.status, 200, 'still a 200 — providers retry on anything else');
  assert.equal(D(r).status, 'rejected');

  const events = D(await req('GET', '/platform/billing/events', { token: platform.token }));
  const row = events.find((e) => e.eventId === eventId);
  assert.ok(row, 'the attempt is kept');
  assert.equal(row.signatureValid, false);
  assert.equal(row.provider, '1bill');
});

test('1bill: a callback for a provider this build does not have is refused, not guessed at', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // Verifying this with some other adapter's secret would be worse than refusing it.
  const body = JSON.stringify({ event_id: `1b-unknown-${randomUUID()}`, event: 'bill.paid', data: {} });
  const r = await req('POST', '/billing/webhook/definitely-not-a-provider', {
    body,
    headers: { 'x-onebill-signature': sign(body) },
  });
  assert.equal(r.status, 200);
  assert.equal(D(r).status, 'rejected');
  assert.match(D(r).detail ?? '', /Unknown provider/i);
});

/* ----------------------------------------------------------- reconciliation */

test('1bill: a LOST callback is recovered by reconciliation', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // A fresh bill, paid at the partner, with NO callback ever delivered — the case that
  // otherwise leaves a paying customer locked out for ever.
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'enterprise', interval: 'month', notes: 'lost callback case' },
  });
  assert.equal(issued.status, 201, issued.raw?.slice(0, 300));

  // A platform-issued invoice is registered with the partner exactly as a customer's own
  // checkout is — an operator's renewal has to be payable too.
  const consumer = await sql(`SELECT provider_invoice_id FROM invoices WHERE id = '${D(issued).id}'`);
  assert.ok(consumer && consumer !== '', 'an operator-issued invoice carries a consumer number');

  await control(`/_control/pay/${encodeURIComponent(consumer)}`, 'POST', { transaction_id: `TXN-LOST-${stamp}` });

  const before = D(await req('GET', `/billing/invoices/${D(issued).id}`, { token: tenant.token }));
  assert.equal(before.status, 'open', 'still open — no callback arrived');

  const run = await req('POST', '/platform/billing/reconcile/run', { token: platform.token });
  assert.equal(run.status, 200, run.raw?.slice(0, 300));
  assert.ok(D(run).settled >= 1, `reconciliation settled it: ${JSON.stringify(D(run).details)}`);

  const after = D(await req('GET', `/billing/invoices/${D(issued).id}`, { token: tenant.token }));
  assert.equal(after.status, 'paid', 'the invoice is settled from the provider status');
});

test('1bill: reconciliation is idempotent and a late callback adds nothing', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const first = await req('POST', '/platform/billing/reconcile/run', { token: platform.token });
  assert.equal(first.status, 200);
  assert.equal(D(first).settled, 0, 'nothing left to settle');

  const payments = D(await req('GET', '/platform/billing/payments', { token: platform.token }));
  const count = payments.filter((p) => p.organizationId === orgId).length;

  // The callback that was "lost" finally turns up, carrying the same transaction id.
  const body = JSON.stringify({
    event_id: `1b-late-${randomUUID()}`,
    event: 'bill.paid',
    data: { transaction_id: `TXN-LOST-${stamp}`, bill_reference: invoiceNumber, amount_minor: 1 },
  });
  const r = await req('POST', '/billing/webhook/1bill', { body, headers: { 'x-onebill-signature': sign(body) } });
  assert.equal(r.status, 200);

  const after = D(await req('GET', '/platform/billing/payments', { token: platform.token }));
  assert.equal(
    after.filter((p) => p.organizationId === orgId).length,
    count,
    'the payment was already recorded once — the late callback adds nothing',
  );
});

test('1bill: an unreachable partner is never read as unpaid', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const planBefore = D(await req('GET', '/billing/summary', { token: tenant.token })).plan;

  await control('/_control/fail');
  const run = await req('POST', '/platform/billing/reconcile/run', { token: platform.token });
  assert.equal(run.status, 200, 'a failing partner does not fail the sweep');

  const planAfter = D(await req('GET', '/billing/summary', { token: tenant.token })).plan;
  assert.equal(planAfter, planBefore, 'and changes nothing');
});

/* ------------------------------------------------------------ partner faults */

test('1bill: a partner outage still leaves the customer a usable invoice', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // Put the tenant back on Starter so a fresh Professional checkout is possible.
  await req('PUT', `/platform/organizations/${orgId}/subscription`, {
    token: platform.token,
    body: { planCode: 'starter', status: 'active' },
  });
  await sql(`UPDATE invoices SET status = 'void' WHERE organization_id = '${orgId}' AND status = 'open'`);

  await control('/_control/fail');
  const r = await req('POST', '/billing/checkout', {
    token: tenant.token,
    body: { planCode: 'professional', interval: 'month' },
  });

  // The customer must not see an error, and must not be left with nothing.
  assert.equal(r.status, 200, `checkout survives a partner outage: ${r.raw?.slice(0, 300)}`);
  assert.ok(D(r).invoiceNumber?.startsWith('INV-'), 'the invoice exists');
  assert.match(D(r).instructions, /could not be registered|contact your supplier/i, 'and says so honestly');

  const inv = await sql(`SELECT status FROM invoices WHERE number = '${D(r).invoiceNumber}'`);
  assert.equal(inv, 'open', 'the invoice is open and payable by other means');
});

test('1bill: a partner that accepts and never answers is cut off by the timeout', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await sql(`UPDATE invoices SET status = 'void' WHERE organization_id = '${orgId}' AND status = 'open'`);

  await control('/_control/hang');
  const started = Date.now();
  const r = await req('POST', '/billing/checkout', {
    token: tenant.token,
    body: { planCode: 'professional', interval: 'month' },
  });
  const elapsed = Date.now() - started;

  assert.equal(r.status, 200, 'the request completes rather than hanging with the customer');
  // ONEBILL_TIMEOUT_MS is set to 3s for this run; allow generous headroom but prove it
  // did not simply wait for the HTTP client's own default.
  assert.ok(elapsed < 12_000, `checkout returned in ${elapsed}ms rather than hanging`);
  assert.ok(D(r).invoiceNumber?.startsWith('INV-'), 'and the invoice still exists');
});

/* --------------------------------------------------------------- the basics */

test('1bill: the free plan needs no partner at all', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await req('POST', '/billing/checkout', { token: tenant.token, body: { planCode: 'starter', interval: 'month' } });
  assert.equal(r.status, 200);
  assert.equal(D(r).free, true);
  assert.equal(D(r).invoiceId, null, 'no invoice, so no bill to register');
});

test('1bill: a tenant still cannot record its own payment', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'enterprise', interval: 'year' },
  });
  assert.equal(issued.status, 201);
  const r = await req('POST', `/platform/billing/invoices/${D(issued).id}/payments`, {
    token: tenant.token,
    body: { reference: 'self-service attempt' },
  });
  assert.ok(r.status === 403 || r.status === 404, `refused (${r.status})`);
});

/* ----------------------------------------- regressions found by code review */

test('1bill: an UNPAID bill is NOT settled by reconciliation', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // THE BUG THIS EXISTS FOR: the status check was a substring match, and "UNPAID"
  // contains "paid". Every open bill on the platform would have been settled for free
  // and booked as revenue on the first sweep.
  await req('PUT', `/platform/organizations/${orgId}/subscription`, {
    token: platform.token,
    body: { planCode: 'starter', status: 'active' },
  });
  await sql(`UPDATE invoices SET status = 'void' WHERE organization_id = '${orgId}' AND status = 'open'`);

  const r = await req('POST', '/billing/checkout', {
    token: tenant.token,
    body: { planCode: 'professional', interval: 'month' },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 300));
  const number = D(r).invoiceNumber;

  // The partner holds it as UNPAID — nobody has paid anything.
  const held = await control('/_control/bills', 'GET');
  const bill = held.bills.find((b) => b.bill_reference === number);
  assert.ok(bill, 'the partner holds the bill');
  assert.equal(bill.status, 'UNPAID');
  assert.equal(bill.paid, false);

  const run = await req('POST', '/platform/billing/reconcile/run', { token: platform.token });
  assert.equal(run.status, 200);
  assert.equal(D(run).settled, 0, `an unpaid bill must not settle: ${JSON.stringify(D(run).details)}`);

  const inv = await sql(`SELECT status FROM invoices WHERE number = '${number}'`);
  assert.equal(inv, 'open', 'the invoice is still open');
  assert.equal(D(await req('GET', '/billing/summary', { token: tenant.token })).plan, 'starter', 'and nothing was given away');
});

test('1bill: a reversal or refund callback never settles an invoice', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // The success test ran before the failure test and matched on a substring, so
  // "refund.completed", "reversal.completed" and "settlement_failed" all contained a
  // word that read as success and were recorded as money received.
  const open = await sql(
    `SELECT number FROM invoices WHERE organization_id = '${orgId}' AND status = 'open' ORDER BY issued_at DESC LIMIT 1`,
  );
  assert.ok(open, 'there is an open invoice to aim at');

  for (const eventType of ['refund.completed', 'reversal.completed', 'settlement_failed', 'bill.reversed']) {
    const eventId = `1b-neg-${randomUUID()}`;
    const body = JSON.stringify({
      event_id: eventId,
      event: eventType,
      data: { bill_reference: open, transaction_id: `TXN-${eventId}`, amount_minor: 1, response_code: '00' },
    });
    const r = await req('POST', '/billing/webhook/1bill', { body, headers: { 'x-onebill-signature': sign(body) } });
    assert.equal(r.status, 200);
    assert.notEqual(D(r).detail ?? '', undefined);

    const status = await sql(`SELECT status FROM invoices WHERE number = '${open}'`);
    assert.equal(status, 'open', `"${eventType}" must not settle the invoice`);
  }

  // Even carrying a success response code, which used to be OR'd in ahead of everything.
  const plan = D(await req('GET', '/billing/summary', { token: tenant.token })).plan;
  assert.equal(plan, 'starter', 'and no plan was granted by a reversal');
});

test('1bill: a reported amount that is not the invoice total is refused', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const number = await sql(
    `SELECT number FROM invoices WHERE organization_id = '${orgId}' AND status = 'open' ORDER BY issued_at DESC LIMIT 1`,
  );
  const consumer = await sql(`SELECT provider_invoice_id FROM invoices WHERE number = '${number}'`);

  // The partner reports it paid, but quotes the amount in rupees rather than paisa —
  // the classic unit mismatch. Recording it would leave a fully paid customer locked out
  // for ever, because every later sweep would dedupe on the payment it just wrote.
  const total = await sql(`SELECT total_minor FROM invoices WHERE number = '${number}'`);
  await control(`/_control/pay/${encodeURIComponent(consumer)}`, 'POST', { transaction_id: `TXN-UNIT-${stamp}` });
  await control(`/_control/amount/${encodeURIComponent(consumer)}`, 'POST', {
    amount_minor: Math.floor(Number(total) / 100),
  });

  const run = await req('POST', '/platform/billing/reconcile/run', { token: platform.token });
  assert.equal(run.status, 200);
  assert.ok(
    D(run).details.some((d) => d.startsWith(number) && /amount mismatch/.test(d)),
    `a mismatched amount is refused with a reason: ${JSON.stringify(D(run).details)}`,
  );
  assert.equal(await sql(`SELECT status FROM invoices WHERE number = '${number}'`), 'open', 'and the invoice stays open');
});

test('1bill: an operator-issued invoice returns the ID the customer has to pay', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // It used to register the bill and tell nobody: no notification, and the 1BILL ID
  // nowhere in the response. The one thing the customer needs went into the database
  // and stopped there.
  const issued = await req('POST', `/platform/billing/organizations/${orgId}/invoices`, {
    token: platform.token,
    body: { planCode: 'professional', interval: 'year', notes: 'operator renewal' },
  });
  assert.equal(issued.status, 201, issued.raw?.slice(0, 300));
  assert.ok(D(issued).providerReference, 'the operator is given the provider reference');
  assert.match(D(issued).instructions ?? '', /1BILL ID:/, 'and the payment instructions');

  // And the customer was told, through the ordinary notification path.
  const notified = await sql(
    `SELECT count(*) FROM notifications WHERE organization_id = '${orgId}' AND template_key = 'billing.invoice_issued'`,
  );
  assert.ok(Number(notified) > 0, 'the customer is notified that an invoice exists');
});

test('1bill: a bill that failed to register is registered on the next sweep', async (t) => {
  if (skipReason) return t.skip(skipReason);

  await sql(`UPDATE invoices SET status = 'void' WHERE organization_id = '${orgId}' AND status = 'open'`);
  await req('PUT', `/platform/organizations/${orgId}/subscription`, {
    token: platform.token,
    body: { planCode: 'starter', status: 'active' },
  });

  // Registration fails, so the invoice exists with no provider reference at all.
  await control('/_control/fail');
  const r = await req('POST', '/billing/checkout', { token: tenant.token, body: { planCode: 'professional', interval: 'month' } });
  assert.equal(r.status, 200);
  const number = D(r).invoiceNumber;
  const before = await sql(`SELECT coalesce(provider_invoice_id,'') FROM invoices WHERE number = '${number}'`);
  assert.equal(before, '', 'no reference was stored');

  // The sweep retries the registration rather than leaving it unpayable for ever.
  const run = await req('POST', '/platform/billing/reconcile/run', { token: platform.token });
  assert.equal(run.status, 200);
  const after = await sql(`SELECT coalesce(provider_invoice_id,'') FROM invoices WHERE number = '${number}'`);
  assert.notEqual(after, '', `the bill was registered on retry: ${JSON.stringify(D(run).details)}`);
});
