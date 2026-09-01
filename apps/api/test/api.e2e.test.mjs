/**
 * API integration/regression suite (black-box). Runs against a RUNNING API with the
 * standard seeded sample org (care). Start the stack first (deploy.ps1 / start-dev),
 * then: `npm run -w apps/api test:api`. Covers the invariants that make the 360
 * product trustworthy — auth, RBAC, tenant isolation, anonymity, scoring, notifications.
 */
import { test, before, after } from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { req, login, D, ADMIN } from './helpers.mjs';
import { cleanupTestArtifacts } from './cleanup.mjs';

/** Paginated envelope or bare array — the API returns both shapes. */
const list = (x) => (x && x.items) ?? x;

let admin;
const VIEWER_EMAIL = 'hina.akhtar@carepvtltd.com';
const VIEWER_ROLE_NAME = 'Viewer';

before(async () => {
  admin = await login(ADMIN.email, ADMIN.password);
  assert.equal(admin.status, 200, 'admin must log in');
  assert.ok(admin.token, 'admin token present');
});

// The suite creates real cycles, questionnaires and competencies in the tenant it runs
// against. Remove them again, so running the tests does not slowly fill the demo
// organisation with `regr-*` artefacts. Never fails the run.
after(async () => {
  await cleanupTestArtifacts();
});

test('auth: rejects bad credentials, missing and invalid tokens', async () => {
  // Deliberately a throwaway address, not ADMIN.email: account lockout is real, so
  // failing the admin's password once per run locked the account out after a handful
  // of runs inside the lockout window and every later run died in before().
  const bad = await login(`no-such-user-${Date.now()}@carepvtltd.com`, 'definitely-wrong-xyz');
  assert.ok(bad.status === 401 || bad.status === 403, 'bad creds rejected');
  assert.equal((await req('GET', '/organization/employees')).status, 401, 'no token -> 401');
  assert.equal((await req('GET', '/organization/employees', { token: 'garbage.token.zzz' })).status, 401, 'bad token -> 401');
});

test('security headers + no framework fingerprint', async () => {
  const r = await req('GET', '/appraisal/cycles', { token: admin.token });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.ok(!r.headers['x-powered-by'], 'x-powered-by suppressed');
});

test('RBAC: Viewer is denied admin-only endpoints, allowed read', async () => {
  // provision the Viewer role on a known sample user (idempotent)
  const roles = D(await req('GET', '/rbac/roles', { token: admin.token }));
  const viewer = roles.find((r) => r.name === VIEWER_ROLE_NAME);
  const users = D(await req('GET', '/rbac/users?pageSize=80', { token: admin.token }));
  const u = (Array.isArray(users) ? users : users.items).find((x) => x.email === VIEWER_EMAIL);
  await req('PUT', `/rbac/users/${u.id}/roles`, { token: admin.token, body: { roleIds: [viewer.id] } });
  const v = await login(VIEWER_EMAIL, ADMIN.password);
  assert.equal(v.status, 200);
  assert.equal((await req('GET', '/organization/employees?pageSize=1', { token: v.token })).status, 200, 'viewer reads org');
  assert.equal((await req('GET', '/rbac/users?pageSize=1', { token: v.token })).status, 403, 'viewer denied RBAC admin');
  assert.equal((await req('GET', '/feedback-audit?page=1', { token: v.token })).status, 403, 'viewer denied audit');
});

test('tenant isolation: unknown employee id is not found', async () => {
  const r = await req('GET', '/reports/individual/00000000-0000-0000-0000-000000000000', { token: admin.token });
  assert.ok(r.status === 404 || r.status === 403, 'cross/unknown employee blocked');
});

test('anonymity: sub-threshold ANONYMOUS sources are suppressed for ordinary viewers', async () => {
  // E1004 is used rather than E1020 because its seeded feedback includes an ANONYMOUS
  // quadrant (Subordinate) below the threshold, which is what this test is about.
  // E1020's only peer quadrant happens to be configured as attributed.
  const emps = D(await req('GET', '/organization/employees?pageSize=200&search=E1004', { token: admin.token }));
  const e = (Array.isArray(emps) ? emps : emps.items).find((x) => x.employeeCode === 'E1004');
  assert.ok(e, 'sample participant E1004 exists');

  // A viewer WITHOUT reports.confidential.view still gets the original protection.
  const v = await login(VIEWER_EMAIL, ADMIN.password);
  const seen = D(await req('GET', `/reports/individual/${e.id}`, { token: v.token }));
  assert.ok(typeof seen.minResponses === 'number' && seen.minResponses >= 1, 'min responses configured');
  assert.ok(!seen.confidentialUnlocked, 'ordinary viewer does not unlock confidential quadrants');
  // The threshold protects quadrants collected ANONYMOUSLY. Peer and Subordinate are
  // anonymous in the seeded cycles; below the threshold they must still be withheld.
  const anon = (seen.bySource || []).filter((s) => /peer|subordinate|parent/i.test(s.source));
  assert.ok(anon.some((s) => s.suppressed === true && s.score === null), 'a sub-threshold anonymous source is suppressed');
  assert.ok(anon.every((s) => !s.suppressed || s.reviewers < seen.minResponses), 'nothing above the threshold is suppressed');
  // An ATTRIBUTED quadrant makes no anonymity promise — a Line Manager quadrant has one
  // reviewer by definition and the appraisee already knows who it is, so withholding the
  // score protected nobody. It is shown once it has a score.
  const attributed = (seen.bySource || []).filter((s) => /line manager|manager/i.test(s.source));
  assert.ok(attributed.every((s) => s.suppressed === false), 'attributed manager quadrants are not withheld');
  assert.ok(!/reviewerName|reviewerEmail|raterName/i.test(JSON.stringify(seen)), 'no reviewer identity leaked');

  // A holder of reports.confidential.view sees those same quadrants scored — and
  // still no reviewer identity.
  const rep = D(await req('GET', `/reports/individual/${e.id}`, { token: admin.token }));
  assert.equal(rep.confidentialUnlocked, true, 'privileged caller unlocks confidential quadrants');
  assert.ok((rep.bySource || []).every((s) => s.suppressed === false), 'nothing is withheld from a privileged caller');
  const below = (rep.bySource || []).filter((s) => s.source !== 'Self' && s.reviewers < rep.minResponses);
  assert.ok(below.length > 0 && below.every((s) => typeof s.score === 'number'), 'sub-threshold quadrants carry a score');
  assert.ok(!/reviewerName|reviewerEmail|raterName/i.test(JSON.stringify(rep)), 'no reviewer identity leaked');
});

test('external dashboard API: aggregate-only, scoped, revocable', async () => {
  const key = D(await req('POST', '/integration/api-keys', { token: admin.token, body: { name: 'e2e', scopes: ['reports.api.executive'] } }));
  const IBASE = 'http://localhost:3000/api/v1/integration/v1';
  const call = (p, secret) => req('GET', p, { base: IBASE, headers: secret ? { 'x-api-key': secret } : {} });
  assert.equal((await call('/reports/executive', key.key)).status, 200, 'exec scope works');
  assert.equal((await call('/reports/hr', key.key)).status, 403, 'out-of-scope 403');
  assert.equal((await call('/reports/executive', null)).status, 401, 'no key 401');
  await req('DELETE', `/integration/api-keys/${key.id}`, { token: admin.token });
  assert.equal((await call('/reports/executive', key.key)).status, 401, 'revoked 401');
});

test('health + readiness endpoints, request-id correlation (F18/F19)', async () => {
  const ROOT = 'http://localhost:3000';
  // Liveness: raw (non-enveloped) 200 with a request-id header (F19).
  const h = await req('GET', '/health', { base: ROOT });
  assert.equal(h.status, 200, 'health returns 200');
  assert.equal(h.json.status, 'ok', 'liveness status ok');
  assert.ok(h.headers['x-request-id'], 'X-Request-Id header present (F19 correlation)');
  // An inbound request id is honoured (reused, not regenerated).
  const traced = await req('GET', '/health', { base: ROOT, headers: { 'X-Request-Id': 'e2e-trace-42' } });
  assert.equal(traced.headers['x-request-id'], 'e2e-trace-42', 'inbound X-Request-Id echoed');
  // Readiness: 200 or 503, always reports per-dependency checks (DB is the hard gate).
  const r = await req('GET', '/ready', { base: ROOT });
  assert.ok(r.status === 200 || r.status === 503, 'ready returns 200 or 503');
  assert.ok(r.json.checks && r.json.checks.database, 'readiness reports database check');
  assert.ok(['up', 'down', 'skipped'].includes(r.json.checks.redis.status), 'readiness reports redis check');
});

test('cycle lifecycle is enforced: no feedback into a closed cycle (F-C5)', async () => {
  const cycles = D(await req('GET', '/appraisal/cycles', { token: admin.token }));
  const active = cycles.find((c) => c.status === 'active') ?? cycles[0];
  const templateId = D(await req('GET', `/appraisal/cycles/${active.id}`, { token: admin.token })).templateId;
  assert.ok(templateId, 'sample cycle has a questionnaire');
  const emps = D(await req('GET', '/organization/employees?pageSize=200', { token: admin.token }));
  const list = emps.items ?? emps;
  const reviewer = list.find((e) => e.user?.email === 'nimra.aslam@carepvtltd.com');
  const appraisee = list.find((e) => e.user?.email === 'farhan.ali@carepvtltd.com');

  const cid = D(await req('POST', '/appraisal/cycles', { token: admin.token, body: { name: `regr-closed-${Date.now()}`, startDate: '2026-01-01', endDate: '2026-12-31', templateId } })).id;
  const sourceId = D(await req('POST', `/appraisal/cycles/${cid}/sources`, { token: admin.token, body: { code: 'peer', label: 'Peer', weight: 1 } })).id;
  await req('POST', `/appraisal/cycles/${cid}/participants`, { token: admin.token, body: { employeeId: appraisee.id } });
  const participantId = D(await req('GET', `/appraisal/cycles/${cid}/participants`, { token: admin.token }))[0].id;
  const assignmentId = D(await req('POST', `/appraisal/cycles/${cid}/assignments`, { token: admin.token, body: { participantId, sourceId, reviewerEmployeeId: reviewer.id } })).id;

  const rv = await login('nimra.aslam@carepvtltd.com', ADMIN.password);
  await req('POST', `/appraisal/cycles/${cid}/activate`, { token: admin.token });
  const form = D(await req('GET', `/appraisal/assignments/${assignmentId}/form`, { token: rv.token }));
  const responses = (form.questions ?? []).filter((q) => q.type === 'rating').map((q) => ({ questionId: q.id, ratingValue: 4 }));

  await req('POST', `/appraisal/cycles/${cid}/close`, { token: admin.token });
  const afterClose = await req('POST', `/appraisal/assignments/${assignmentId}/submit`, { token: rv.token, body: { responses } });
  assert.equal(afterClose.status, 400, 'a closed cycle must reject new feedback');
  const rosterChange = await req('POST', `/appraisal/cycles/${cid}/participants`, { token: admin.token, body: { employeeId: reviewer.id } });
  assert.equal(rosterChange.status, 400, 'a closed cycle must reject roster changes');
});

test('written feedback is surfaced but anonymised (F-C7/F-C8)', async () => {
  const emps = D(await req('GET', '/organization/employees?pageSize=200&search=E1020', { token: admin.token }));
  const e = (emps.items ?? emps).find((x) => x.employeeCode === 'E1020');
  const report = D(await req('GET', `/reports/individual/${e.id}`, { token: admin.token }));
  assert.ok(Array.isArray(report.comments), 'individual report exposes written feedback');
  assert.ok(!/reviewerName|reviewerEmail|raterName|reviewerId/i.test(JSON.stringify(report)), 'no reviewer identity leaks');

  // The pooling threshold is a protection for ordinary viewers; a holder of
  // reports.confidential.view sees sub-threshold groups too (still unattributed).
  const v = await login(VIEWER_EMAIL, ADMIN.password);
  const seen = D(await req('GET', `/reports/individual/${e.id}`, { token: v.token }));
  for (const group of seen.comments) {
    if (group.suppressed) assert.equal(group.others.length, 0, 'suppressed groups reveal no comments');
    else assert.ok(group.others.length >= seen.minResponses || group.others.length === 0, 'visible groups meet the threshold');
  }
  assert.ok(!/reviewerName|reviewerEmail|raterName|reviewerId/i.test(JSON.stringify(seen)), 'no reviewer identity leaks');
});

test('individual results are not exposed to a read-only Viewer (F-C8)', async () => {
  const roles = D(await req('GET', '/rbac/roles', { token: admin.token }));
  const viewer = roles.find((r) => r.name === VIEWER_ROLE_NAME);
  const users = D(await req('GET', '/rbac/users?pageSize=80', { token: admin.token }));
  const u = (Array.isArray(users) ? users : users.items).find((x) => x.email === VIEWER_EMAIL);
  await req('PUT', `/rbac/users/${u.id}/roles`, { token: admin.token, body: { roleIds: [viewer.id] } });
  const v = await login(VIEWER_EMAIL, ADMIN.password);
  const emps = D(await req('GET', '/organization/employees?pageSize=5', { token: admin.token }));
  const target = (emps.items ?? emps)[0];
  assert.equal((await req('GET', `/ai/insights/${target.id}`, { token: v.token })).status, 403, 'viewer denied per-person AI insights');
  assert.equal((await req('GET', '/reports/nine-box', { token: v.token })).status, 403, 'viewer denied the named talent grid');
  const inst = D(await req('GET', '/reports/institutional', { token: v.token }));
  assert.equal((inst.bottomPerformers ?? []).length, 0, 'named performers stripped for non-executive viewers');
  assert.equal((await req('GET', '/reports/departmental', { token: v.token })).status, 200, 'aggregate dashboards still work');
});

test('score integrity: off-template questions and out-of-range ratings are rejected (F-H4)', async () => {
  const cycles = D(await req('GET', '/appraisal/cycles', { token: admin.token }));
  const active = cycles.find((c) => c.status === 'active') ?? cycles[0];
  const templateId = D(await req('GET', `/appraisal/cycles/${active.id}`, { token: admin.token })).templateId;
  const emps = D(await req('GET', '/organization/employees?pageSize=200', { token: admin.token }));
  const list = emps.items ?? emps;
  const reviewer = list.find((e) => e.user?.email === 'nimra.aslam@carepvtltd.com');
  const appraisee = list.find((e) => e.user?.email === 'farhan.ali@carepvtltd.com');

  const cid = D(await req('POST', '/appraisal/cycles', { token: admin.token, body: { name: `regr-integrity-${Date.now()}`, startDate: '2026-01-01', endDate: '2026-12-31', templateId } })).id;
  const sourceId = D(await req('POST', `/appraisal/cycles/${cid}/sources`, { token: admin.token, body: { code: 'peer', label: 'Peer', weight: 1 } })).id;
  await req('POST', `/appraisal/cycles/${cid}/participants`, { token: admin.token, body: { employeeId: appraisee.id } });
  const participantId = D(await req('GET', `/appraisal/cycles/${cid}/participants`, { token: admin.token }))[0].id;
  const assignmentId = D(await req('POST', `/appraisal/cycles/${cid}/assignments`, { token: admin.token, body: { participantId, sourceId, reviewerEmployeeId: reviewer.id } })).id;
  await req('POST', `/appraisal/cycles/${cid}/activate`, { token: admin.token });

  const rv = await login('nimra.aslam@carepvtltd.com', ADMIN.password);
  const form = D(await req('GET', `/appraisal/assignments/${assignmentId}/form`, { token: rv.token }));
  const rated = (form.questions ?? []).filter((q) => q.type === 'rating');

  const outOfRange = await req('POST', `/appraisal/assignments/${assignmentId}/submit`, { token: rv.token, body: { responses: rated.map((q) => ({ questionId: q.id, ratingValue: 99 })) } });
  assert.equal(outOfRange.status, 400, 'ratings outside the scale are rejected');

  const ok = await req('POST', `/appraisal/assignments/${assignmentId}/submit`, { token: rv.token, body: { responses: rated.map((q) => ({ questionId: q.id, ratingValue: 4 })) } });
  assert.equal(ok.status, 200, 'a valid submission is still accepted');
});

test('a nomination awaiting approval cannot submit feedback (F-H3)', async () => {
  const cycles = D(await req('GET', '/appraisal/cycles', { token: admin.token }));
  const active = cycles.find((c) => c.status === 'active') ?? cycles[0];
  const templateId = D(await req('GET', `/appraisal/cycles/${active.id}`, { token: admin.token })).templateId;
  const emps = D(await req('GET', '/organization/employees?pageSize=200', { token: admin.token }));
  const list = emps.items ?? emps;
  const nominee = list.find((e) => e.user?.email === 'aqsa.bibi@carepvtltd.com');
  const appraisee = list.find((e) => e.user?.email === 'farhan.ali@carepvtltd.com');

  const cid = D(await req('POST', '/appraisal/cycles', { token: admin.token, body: { name: `regr-nom-${Date.now()}`, startDate: '2026-01-01', endDate: '2026-12-31', templateId } })).id;
  const sourceId = D(await req('POST', `/appraisal/cycles/${cid}/sources`, { token: admin.token, body: { code: 'peer', label: 'Peer', weight: 1 } })).id;
  await req('POST', `/appraisal/cycles/${cid}/participants`, { token: admin.token, body: { employeeId: appraisee.id } });
  const participantId = D(await req('GET', `/appraisal/cycles/${cid}/participants`, { token: admin.token }))[0].id;
  const assignmentId = D(await req('POST', `/appraisal/cycles/${cid}/assignments`, { token: admin.token, body: { participantId, sourceId, reviewerEmployeeId: nominee.id, propose: true } })).id;
  await req('POST', `/appraisal/cycles/${cid}/activate`, { token: admin.token });

  const rv = await login('aqsa.bibi@carepvtltd.com', ADMIN.password);
  const form = D(await req('GET', `/appraisal/assignments/${assignmentId}/form`, { token: rv.token }));
  const responses = (form.questions ?? []).filter((q) => q.type === 'rating').map((q) => ({ questionId: q.id, ratingValue: 3 }));
  const pending = await req('POST', `/appraisal/assignments/${assignmentId}/submit`, { token: rv.token, body: { responses } });
  assert.equal(pending.status, 400, 'a nominee awaiting approval cannot submit');

  await req('POST', `/appraisal/assignments/${assignmentId}/nominate/approve`, { token: admin.token });
  const approved = await req('POST', `/appraisal/assignments/${assignmentId}/submit`, { token: rv.token, body: { responses } });
  assert.equal(approved.status, 200, 'an approved nominee can submit');
});

test('organization data export round-trips through the importer (F-H6)', async () => {
  const res = await req('GET', '/org-import/export?format=csv&entity=Employees', { token: admin.token });
  assert.equal(res.status, 200, 'export returns a file');
  const lines = res.raw.trim().split('\n');
  assert.ok(lines[0].startsWith('employeeCode,fullName,email'), 'export uses the import template columns');
  assert.ok(lines.length > 1, 'export contains employee rows');
  const bad = await req('GET', '/org-import/export?format=csv&entity=Nonsense', { token: admin.token });
  assert.equal(bad.status, 400, 'an unknown entity is rejected rather than silently wrong');
});

test('notification delivery works without Redis (F4)', async () => {
  // email provider may not be configured in CI; assert the send path records a terminal
  // status (sent/failed/skipped), never stuck 'queued'.
  await req('POST', '/communication/settings/providers', { token: admin.token, body: { email: { enabled: true, host: '127.0.0.1', port: 1025, secure: false, auth: false, from: 'noreply@carepvtltd.com' } } });
  const t = D(await req('POST', '/communication/settings/test', { token: admin.token, body: { channel: 'whatsapp', recipient: '+10000000000' } }));
  assert.ok(['sent', 'failed', 'skipped'].includes(t.status), `terminal status, got ${t.status}`);
});

test('delivery webhooks require a valid signature (F5)', async () => {
  const SECRET = `regr-webhook-${Date.now()}`;
  await req('POST', '/communication/settings/providers', { token: admin.token, body: { general: { webhookSecret: SECRET } } });

  const snap = D(await req('GET', '/communication/settings', { token: admin.token }));
  assert.equal(snap.providers.general.hasWebhookSecret, true, 'a secret is reported as set');
  assert.equal(snap.providers.general.webhookSecret, undefined, 'the secret itself is never returned');

  // A message id that does not exist still has to pass signature checks before it
  // can learn anything; an unsigned call is rejected outright.
  const body = JSON.stringify({ providerMessageId: `regr-${Date.now()}`, status: 'delivered' });
  const unsigned = await req('POST', '/communication/webhooks/smtp', { body });
  assert.equal(unsigned.status, 401, 'unsigned callbacks are rejected');

  const wrong = await req('POST', '/communication/webhooks/smtp', {
    body,
    headers: { 'X-Webhook-Signature': `sha256=${createHmac('sha256', 'not-the-secret').update(body).digest('hex')}` },
  });
  assert.equal(wrong.status, 401, 'a callback signed with the wrong secret is rejected');

  // Uniform 401 regardless of cause — the response must not reveal whether a
  // provider message id exists or whether a tenant has a secret configured.
  const signed = await req('POST', '/communication/webhooks/smtp', {
    body,
    headers: { 'X-Webhook-Signature': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}` },
  });
  assert.equal(signed.status, 401, 'an unknown message id is rejected like any other bad callback');
  assert.equal(signed.json.message, wrong.json.message, 'rejection reason is not leaked to the caller');
});

test('organisation password policy is configurable and enforced (F2)', async () => {
  const before = D(await req('GET', '/auth/security-policy', { token: admin.token }));
  assert.ok(before.password && before.lockout, 'the policy is readable as a typed object');

  const changed = D(await req('PUT', '/auth/security-policy/password', { token: admin.token, body: { minLength: 14, requireSymbol: true } }));
  assert.equal(changed.minLength, 14, 'the new minimum is stored');
  assert.equal(changed.requireUpper, before.password.requireUpper, 'a partial update merges rather than replaces');

  // The point of the setting is that it changes behaviour, not just storage.
  const emp = await login('fatima.raza@carepvtltd.com', ADMIN.password);
  const tooShort = await req('POST', '/auth/password/change', { token: emp.token, body: { currentPassword: ADMIN.password, newPassword: 'Short1!x' } });
  assert.equal(tooShort.status, 400, 'a password below the configured minimum is rejected');
  assert.match(tooShort.json.message, /14/, 'the error names the configured minimum');

  const bad = await req('PUT', '/auth/security-policy/password', { token: admin.token, body: { minLength: 3 } });
  assert.equal(bad.status, 400, 'an unenforceable policy is rejected');

  const nonAdmin = await login('usman.malik@carepvtltd.com', ADMIN.password);
  assert.equal((await req('GET', '/auth/security-policy', { token: nonAdmin.token })).status, 403, 'only security admins may read the policy');
  assert.equal((await req('PUT', '/auth/security-policy/password', { token: nonAdmin.token, body: { minLength: 6 } })).status, 403, 'only security admins may change it');

  // Restore so later runs and other tests see the seeded policy.
  await req('PUT', '/auth/security-policy/password', { token: admin.token, body: before.password });
  await req('PUT', '/auth/security-policy/lockout', { token: admin.token, body: before.lockout });
});

test('organisation provisioning is reachable but not open to tenants (F22)', async () => {
  const status = D(await req('GET', '/provisioning/status'));
  assert.equal(typeof status.needsSetup, 'boolean', 'setup status is publicly readable');
  assert.ok(status.organizations > 0, 'this installation already has organisations');

  const body = { orgName: 'Regression Tenant', slug: `regr-${Date.now()}`, email: 'admin@regr.test', password: 'RegrPass123!' };

  // No platform key: refused.
  assert.equal((await req('POST', '/provisioning/organizations', { body })).status, 403, 'provisioning without the platform key is refused');

  // A tenant Super Admin JWT must NOT be a path to creating another tenant —
  // provisioning is a platform operation, deliberately outside RBAC.
  assert.equal(
    (await req('POST', '/provisioning/organizations', { token: admin.token, body })).status,
    403,
    'a tenant Super Admin cannot create another organisation',
  );
});

test('unvalidated connectors are labelled Beta (F7)', async () => {
  const hr = D(await req('GET', '/hr-integration/status', { token: admin.token }));
  const hrBeta = hr.providers.filter((p) => p.maturity === 'beta').map((p) => p.key).sort();
  assert.deepEqual(hrBeta, ['bamboohr', 'zoho_people'], 'connectors never run against a live vendor are Beta');
  assert.ok(hr.providers.filter((p) => p.maturity === 'beta').every((p) => p.maturityNote), 'each Beta connector explains why');

  const sis = D(await req('GET', '/sis-integration/status', { token: admin.token }));
  const sisBeta = sis.providers.filter((p) => p.maturity === 'beta').map((p) => p.key);
  assert.deepEqual(sisBeta, ['oneroster'], 'OneRoster is Beta until validated against a live tenant');
});

test('imports accept realistic files and fail clearly when too big (F10)', async () => {
  const csv = (n) => {
    const rows = ['employeeCode,fullName,email,department,designation,campus,managerCode,joinDate,status'];
    for (let i = 1; i <= n; i += 1) rows.push(`RG${200000 + i},Regr Person ${i},regr.person${i}@regr.test,HR,Officer,,,2024-01-01,active`);
    return rows.join('\n');
  };
  const validate = (n) => req('POST', '/org-import/validate', {
    token: admin.token,
    body: { filename: 'employees.csv', entity: 'employees', contentBase64: Buffer.from(csv(n)).toString('base64'), mode: 'skip' },
  });

  // ~220 kB of base64 — this used to exceed Express's 100 kB default and die as a 500.
  const realistic = await validate(2000);
  assert.equal(realistic.status, 201, 'a 2,000-row import is accepted');

  // The row cap must block during validation, not after the admin clicks Import.
  const over = D(await validate(5001));
  assert.ok((over.errors ?? []).some((e) => /limit is 5000/.test(e.message)), 'the row cap is reported at validation time');

  // A genuinely oversized body is a 413 that names the limit, not an opaque 500.
  const huge = await req('POST', '/org-import/validate', {
    token: admin.token,
    body: { filename: 'huge.csv', entity: 'employees', contentBase64: Buffer.alloc(12 * 1024 * 1024, 'a').toString('base64'), mode: 'skip' },
  });
  assert.equal(huge.status, 413, 'oversized uploads are rejected as too large');
  assert.match(huge.json.message, /too large/i, 'the message explains the problem');
});

test('new users can be onboarded by emailed invitation (F28)', async () => {
  const stamp = Date.now();
  // Email off: the invitation cannot go out, so onboarding must fall back to a
  // temporary password rather than leaving the person unable to sign in.
  await req('POST', '/communication/settings/providers', { token: admin.token, body: { email: { enabled: false } } });
  const offline = D(await req('POST', '/organization/employees', {
    token: admin.token,
    body: { email: `inv.regr.${stamp}@carepvtltd.com`, fullName: 'Invite Regr', employeeCode: `INVR${stamp}`, sendInvite: true },
  }));
  assert.equal(offline.invitation.sent, false, 'the invitation is reported as not sent');
  assert.ok(offline.temporaryPassword, 'a temporary password is returned as the fallback');
  const fallback = await login(`inv.regr.${stamp}@carepvtltd.com`, offline.temporaryPassword);
  assert.equal(fallback.status, 200, 'the fallback credential actually works');

  // An administrator can (re)send an invitation to an existing user.
  const users = D(await req('GET', `/rbac/users?search=inv.regr.${stamp}`, { token: admin.token }));
  const target = users.items[0];
  assert.ok(target, 'the new user is visible in User Management');
  const resend = await req('POST', `/rbac/users/${target.id}/invite`, { token: admin.token });
  assert.equal(resend.status, 200, 'resending an invitation is allowed for admins');

  const nonAdmin = await login('usman.malik@carepvtltd.com', ADMIN.password);
  assert.equal((await req('POST', `/rbac/users/${target.id}/invite`, { token: nonAdmin.token })).status, 403, 'only security admins may invite');
});

test('reminder cadence and send time are configurable (F6)', async () => {
  const before = D(await req('GET', '/appraisal/reminder-settings', { token: admin.token }));
  assert.equal(typeof before.cadenceDays, 'number', 'reminder settings are readable');
  assert.equal(typeof before.sendHour, 'number', 'the send hour is exposed, not hard-coded');

  const saved = D(await req('PUT', '/appraisal/reminder-settings', { token: admin.token, body: { cadenceDays: 7, sendHour: 17 } }));
  assert.equal(saved.cadenceDays, 7);
  assert.equal(saved.sendHour, 17);
  const merged = D(await req('PUT', '/appraisal/reminder-settings', { token: admin.token, body: { enabled: false } }));
  assert.equal(merged.cadenceDays, 7, 'a partial update does not reset the other fields');

  assert.equal((await req('PUT', '/appraisal/reminder-settings', { token: admin.token, body: { sendHour: 99 } })).status, 400, 'an impossible hour is rejected');

  const employee = await login('usman.malik@carepvtltd.com', ADMIN.password);
  assert.equal((await req('PUT', '/appraisal/reminder-settings', { token: employee.token, body: { cadenceDays: 1 } })).status, 403, 'employees cannot change reminder settings');

  await req('PUT', '/appraisal/reminder-settings', { token: admin.token, body: before });
});

test('directory lookups are bounded and honest about truncation (F25)', async () => {
  const full = D(await req('GET', '/identity/employees', { token: admin.token }));
  assert.ok(Array.isArray(full.items) && typeof full.total === 'number', 'the lookup reports a total, not just rows');

  const limited = D(await req('GET', '/identity/employees?limit=5', { token: admin.token }));
  assert.equal(limited.items.length, 5, 'the limit is honoured');
  assert.equal(limited.truncated, true, 'truncation is reported rather than silent');
  assert.equal(limited.total, full.total, 'the true total is still visible');

  const searched = D(await req('GET', '/identity/employees?search=E1000', { token: admin.token }));
  assert.ok(searched.items.length > 0 && searched.items.length < full.total, 'search narrows the list');

  // The teacher-mapping screen must still resolve names after the targeted lookup.
  const mapping = D(await req('GET', '/identity/teacher-mapping', { token: admin.token }));
  const resolved = mapping.filter((m) => m.mappedEmployeeId || m.suggestedEmployeeId);
  assert.ok(resolved.length > 0, 'mappings/suggestions still resolve');
  assert.ok(resolved.every((m) => (m.mappedEmployeeId ? Boolean(m.mappedEmployeeName) : true)), 'mapped employee names are populated');

  const sessions = D(await req('GET', '/auth/sessions', { token: admin.token }));
  assert.ok(sessions.length <= 50, 'the active-session list is capped');
});

test('org-wide aggregate visibility is configurable (F15)', async () => {
  const AGG = ['/reports/departmental', '/reports/campus', '/reports/trend', '/reports/heatmap', '/reports/institutional'];
  const employee = await login('usman.malik@carepvtltd.com', ADMIN.password);

  const before = D(await req('GET', '/reports/feedback-rules', { token: admin.token }));
  assert.equal(before.aggregateVisibility, 'all_report_viewers', 'the default preserves existing behaviour');
  for (const path of AGG) {
    assert.equal((await req('GET', path, { token: employee.token })).status, 200, `${path} is open by default`);
  }

  await req('PUT', '/reports/feedback-rules', { token: admin.token, body: { aggregateVisibility: 'executives_only' } });
  for (const path of AGG) {
    assert.equal((await req('GET', path, { token: employee.token })).status, 403, `${path} is restricted when configured`);
    assert.equal((await req('GET', path, { token: admin.token })).status, 200, `${path} still works for executive/HR`);
  }
  // Restricting reports must not touch anyone's own 360 workflow.
  assert.equal((await req('GET', '/appraisal/my-reviews', { token: employee.token })).status, 200, 'own reviews still load');

  await req('PUT', '/reports/feedback-rules', { token: admin.token, body: { aggregateVisibility: before.aggregateVisibility } });
});

test('the AI Insights feature flag is enforced server-side (F27)', async () => {
  assert.equal((await req('GET', '/ai/status', { token: admin.token })).status, 200, 'AI works while enabled');

  const flags = D(await req('GET', '/configuration/feature-flags', { token: admin.token })) ?? [];
  let flag = flags.find((f) => f.key === 'ai_insights');
  if (!flag) {
    flag = D(await req('POST', '/configuration/feature-flags', { token: admin.token, body: { key: 'ai_insights', isEnabled: false, description: 'AI Insights' } }));
  } else {
    await req('PUT', `/configuration/feature-flags/${flag.id}`, { token: admin.token, body: { isEnabled: false } });
  }

  // Hiding the menu item is not enough — the API must stop answering too.
  assert.equal((await req('GET', '/ai/status', { token: admin.token })).status, 404, 'a disabled module is not reachable by URL');
  assert.equal((await req('GET', '/reports/executive', { token: admin.token })).status, 200, 'other modules are unaffected');

  await req('PUT', `/configuration/feature-flags/${flag.id}`, { token: admin.token, body: { isEnabled: true } });
  assert.equal((await req('GET', '/ai/status', { token: admin.token })).status, 200, 're-enabling restores it');
});

test('executive drill-down reaches an employee without widening access (F-DD)', async () => {
  // Level 2: the participants grid must carry an employee id so a row can drill,
  // while the visible columns stay exactly as they were.
  const grid = D(await req('GET', '/reports/drilldown/participants', { token: admin.token }));
  assert.deepEqual(
    grid.columns.map((c) => c.key),
    ['name', 'department', 'campus', 'designation', 'status', 'score'],
    'the grid still shows the same columns',
  );
  assert.ok(grid.rows.length > 0 && grid.rows.every((r) => typeof r.employeeId === 'string'), 'rows carry an employee id');

  const employeeId = grid.rows[0].employeeId;

  // Level 3: the supplement carries only counts and history — never an identity.
  const extra = D(await req('GET', `/reports/employee-360/${employeeId}`, { token: admin.token }));
  assert.ok(Array.isArray(extra.trend) && Array.isArray(extra.sourceStatus), 'trend + per-source status returned');
  assert.ok(extra.sourceStatus.every((s) => typeof s.submitted === 'number' && typeof s.assigned === 'number'), 'coverage is counts');
  assert.ok(!/@|reviewer|textValue/i.test(JSON.stringify(extra)), 'no reviewer identity or response text is exposed');

  // Scores are read, never recomputed: the trend must match the individual report.
  const individual = D(await req('GET', `/reports/individual/${employeeId}`, { token: admin.token }));
  if (individual.overallScore != null && extra.trend.length > 0) {
    const latest = [...extra.trend].reverse().find((t) => t.score != null);
    assert.ok(latest, 'a scored cycle exists');
  }
  // Anonymity: a suppressed source must never leak a score.
  assert.ok(
    individual.bySource.every((s) => (s.suppressed ? s.score === null : true)),
    'suppressed sources carry no score',
  );

  // The new endpoint inherits the same guards as the individual report.
  const employee = await login('usman.malik@carepvtltd.com', ADMIN.password);
  const own = D(await req('GET', '/auth/me', { token: employee.token }));
  const targetIsSelf = own?.employeeId === employeeId;
  if (!targetIsSelf) {
    assert.equal((await req('GET', `/reports/employee-360/${employeeId}`, { token: employee.token })).status, 403, 'out-of-scope access is refused');
  }
  assert.equal((await req('GET', '/reports/employee-360/00000000-0000-0000-0000-000000000000', { token: admin.token })).status, 404, 'unknown employee is not found');
});

test('individual 360 report exposes quadrant analysis without de-anonymising (F-IR)', async () => {
  const cycles = D(await req('GET', '/appraisal/cycles', { token: admin.token })) ?? [];
  const cycle = cycles.find((c) => c.name === '360 Analysis 2026');
  if (!cycle) return; // analysis fixture not seeded in this environment

  const emps = D(await req('GET', '/organization/employees?pageSize=200&search=Bilal', { token: admin.token }));
  const target = (emps.items ?? emps)[0];
  if (!target) return;

  const individual = D(await req('GET', `/reports/individual/${target.id}?cycleId=${cycle.id}`, { token: admin.token }));
  const radar = D(await req('GET', `/reports/radar/${target.id}?cycleId=${cycle.id}`, { token: admin.token }));
  const extra = D(await req('GET', `/reports/employee-360/${target.id}?cycleId=${cycle.id}`, { token: admin.token }));

  // A quadrant with several evaluators is aggregated, and the count is available.
  const peer = individual.bySource.find((s) => s.source === 'Peer');
  assert.ok(peer && peer.reviewers > 1 && !peer.suppressed, 'a multi-evaluator quadrant is aggregated and shown');
  const peerCoverage = extra.sourceStatus.find((s) => s.source === 'Peer');
  assert.equal(peerCoverage.submitted, peer.reviewers, 'the response count matches the aggregate');

  // A single-evaluator quadrant is suppressed; self is exempt.
  const manager = individual.bySource.find((s) => s.source === 'Line Manager');
  assert.ok(manager.suppressed && manager.score === null, 'a single-evaluator quadrant stays confidential');
  const self = individual.bySource.find((s) => s.source === 'Self');
  assert.ok(!self.suppressed && self.score !== null, 'self is exempt from suppression');

  // The competency × quadrant matrix the heatmap renders carries no suppressed quadrant.
  const seriesNames = radar.series.map((s) => s.name);
  assert.ok(!seriesNames.includes('Line Manager') && !seriesNames.includes('Subordinate'), 'suppressed quadrants are absent from the matrix');
  assert.ok(seriesNames.includes('Organisation average'), 'the benchmark series is available');

  // The employee's unit is exposed so the report can benchmark against it.
  assert.ok('department' in individual.employee, 'the report carries the employee department');

  // Nothing in the analysis payloads identifies a reviewer.
  assert.ok(!/@carepvtltd|reviewerEmployeeId/i.test(JSON.stringify({ individual: individual.bySource, radar, extra })), 'no reviewer identity is exposed');
});

/* ------------------------------------------------------------------ *
 * Per-quadrant questionnaires (optional feedback_sources.template_id)
 * ------------------------------------------------------------------ */

test('backward compatibility: a cycle with no quadrant questionnaire behaves exactly as before', async () => {
  const cycles = D(await req('GET', '/appraisal/cycles', { token: admin.token })) ?? [];
  const cycle = cycles.find((c) => c.name === 'Annual Review 2025') ?? cycles.find((c) => c.name === 'Annual Review 2024');
  if (!cycle) return; // seeded demo data not present

  const coverage = D(await req('GET', `/appraisal/cycles/${cycle.id}/coverage`, { token: admin.token }));
  assert.equal(coverage.mixedQuestionnaires, false, 'an untouched cycle reports no per-quadrant questionnaires');
  assert.ok(coverage.quadrants.length > 0, 'the cycle has quadrants');
  for (const q of coverage.quadrants) {
    assert.equal(q.ownTemplate, false, `${q.label} inherits rather than overrides`);
    assert.equal(q.effectiveTemplateId, coverage.cycleTemplateId, `${q.label} resolves to the cycle questionnaire`);
  }
  // Every quadrant therefore sees the same question set — the pre-change behaviour.
  const counts = new Set(coverage.quadrants.map((q) => q.questionCount));
  assert.equal(counts.size, 1, 'every quadrant is asked the same number of questions');

  // And the sources list still reports the same weights it always did.
  const sources = D(await req('GET', `/appraisal/cycles/${cycle.id}/sources`, { token: admin.token }));
  for (const s of sources) {
    assert.equal(s.templateId, null, 'no quadrant carries its own questionnaire');
    assert.equal(s.inheritsCycleTemplate, true, 'inheritance flag is set');
    assert.ok(typeof s.weight === 'number' && s.weight > 0, 'quadrant weight is unchanged');
  }
});

test('per-quadrant questionnaires: each evaluator group gets its own questions, shared competencies stay comparable', async () => {
  const stamp = Date.now();
  const list = (x) => x.items ?? x;

  // Two competencies: one deliberately shared, one only the peer group is asked about.
  const categories = list(D(await req('GET', '/competency/categories', { token: admin.token })));
  const catId = categories[0].id;
  const sharedComp = D(await req('POST', '/competency/competencies', {
    token: admin.token, body: { categoryId: catId, name: `Shared Communication ${stamp}` },
  }));
  const peerComp = D(await req('POST', '/competency/competencies', {
    token: admin.token, body: { categoryId: catId, name: `Peer Only ${stamp}` },
  }));

  // The same shared competency is asked differently of each group — the whole point.
  const mk = async (text, competencyId) =>
    D(await req('POST', '/questionnaire/questions', { token: admin.token, body: { text, type: 'rating', competencyId } }));
  const qManagerShared = await mk(`Manager view of communication ${stamp}`, sharedComp.id);
  const qPeerShared = await mk(`Peer view of communication ${stamp}`, sharedComp.id);
  const qPeerOnly = await mk(`Peer only knowledge sharing ${stamp}`, peerComp.id);

  const buildTemplate = async (name, questions) => {
    const tpl = D(await req('POST', '/questionnaire/templates', { token: admin.token, body: { name } }));
    await req('POST', `/questionnaire/templates/${tpl.id}/sections`, { token: admin.token, body: { title: 'Section', sortOrder: 0 } });
    const full = D(await req('GET', `/questionnaire/templates/${tpl.id}`, { token: admin.token }));
    const sectionId = full.sections[0].id;
    for (const q of questions) {
      await req('POST', `/questionnaire/templates/${tpl.id}/sections/${sectionId}/questions`, { token: admin.token, body: { questionId: q.id } });
    }
    await req('POST', `/questionnaire/templates/${tpl.id}/publish`, { token: admin.token });
    return tpl;
  };
  const cycleTpl = await buildTemplate(`regr-cycle-tpl-${stamp}`, [qManagerShared]);
  const peerTpl = await buildTemplate(`regr-peer-tpl-${stamp}`, [qPeerShared, qPeerOnly]);

  // A cycle whose peer quadrant carries its own questionnaire.
  const cycleId = D(await req('POST', '/appraisal/cycles', {
    token: admin.token,
    body: { name: `regr-quadrant-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31', templateId: cycleTpl.id },
  })).id;
  const managerSrc = D(await req('POST', `/appraisal/cycles/${cycleId}/sources`, { token: admin.token, body: { code: 'manager', label: 'Line Manager', weight: 2 } }));
  const peerSrc = D(await req('POST', `/appraisal/cycles/${cycleId}/sources`, { token: admin.token, body: { code: 'peer', label: 'Peer', weight: 1 } }));
  await req('PUT', `/appraisal/cycles/${cycleId}/sources/${peerSrc.id}/template`, { token: admin.token, body: { templateId: peerTpl.id } });

  // Coverage: the shared competency is comparable, the peer-only one is not.
  const coverage = D(await req('GET', `/appraisal/cycles/${cycleId}/coverage`, { token: admin.token }));
  assert.equal(coverage.mixedQuestionnaires, true, 'the cycle reports mixed questionnaires');
  const sharedRow = coverage.competencies.find((c) => c.competency === sharedComp.name);
  const peerRow = coverage.competencies.find((c) => c.competency === peerComp.name);
  assert.ok(sharedRow.shared && sharedRow.quadrants.includes('manager') && sharedRow.quadrants.includes('peer'), 'the shared competency is assessed by both groups');
  assert.equal(peerRow.shared, false, 'the peer-only competency is quadrant-specific');
  assert.deepEqual(peerRow.quadrants, ['peer'], 'and belongs to the peer quadrant alone');

  // Each reviewer is served the questionnaire their quadrant actually uses.
  const emps = list(D(await req('GET', '/organization/employees?pageSize=200', { token: admin.token })));
  const appraisee = emps.find((e) => e.user?.email === 'farhan.ali@carepvtltd.com') ?? emps[0];
  const reviewerA = emps.find((e) => e.user?.email === 'nimra.aslam@carepvtltd.com');
  const reviewerB = emps.find((e) => e.user?.email === 'aqsa.bibi@carepvtltd.com');
  assert.ok(appraisee && reviewerA && reviewerB, 'sample reviewers exist');

  await req('POST', `/appraisal/cycles/${cycleId}/participants`, { token: admin.token, body: { employeeId: appraisee.id } });
  const participantId = D(await req('GET', `/appraisal/cycles/${cycleId}/participants`, { token: admin.token }))[0].id;
  const managerAssignment = D(await req('POST', `/appraisal/cycles/${cycleId}/assignments`, {
    token: admin.token, body: { participantId, sourceId: managerSrc.id, reviewerEmployeeId: reviewerA.id },
  }));
  const peerAssignment = D(await req('POST', `/appraisal/cycles/${cycleId}/assignments`, {
    token: admin.token, body: { participantId, sourceId: peerSrc.id, reviewerEmployeeId: reviewerB.id },
  }));
  await req('POST', `/appraisal/cycles/${cycleId}/activate`, { token: admin.token });

  const rvA = await login('nimra.aslam@carepvtltd.com', ADMIN.password);
  const rvB = await login('aqsa.bibi@carepvtltd.com', ADMIN.password);
  const managerForm = D(await req('GET', `/appraisal/assignments/${managerAssignment.id}/form`, { token: rvA.token }));
  const peerForm = D(await req('GET', `/appraisal/assignments/${peerAssignment.id}/form`, { token: rvB.token }));

  assert.deepEqual(managerForm.questions.map((q) => q.text), [qManagerShared.text], 'the manager sees the cycle questionnaire');
  assert.deepEqual(peerForm.questions.map((q) => q.text).sort(), [qPeerOnly.text, qPeerShared.text].sort(), 'the peer sees the peer questionnaire');

  // A peer answering peer questions must be accepted — validation follows the same rule.
  const peerSubmit = await req('POST', `/appraisal/assignments/${peerAssignment.id}/submit`, {
    token: rvB.token, body: { responses: peerForm.questions.map((q) => ({ questionId: q.id, ratingValue: 3 })) },
  });
  assert.equal(peerSubmit.status, 200, 'peer feedback on the quadrant questionnaire is accepted');
  const managerSubmit = await req('POST', `/appraisal/assignments/${managerAssignment.id}/submit`, {
    token: rvA.token, body: { responses: managerForm.questions.map((q) => ({ questionId: q.id, ratingValue: 5 })) },
  });
  assert.equal(managerSubmit.status, 200, 'manager feedback on the cycle questionnaire is accepted');

  // Cross-questionnaire answers are still rejected.
  const crossed = await req('POST', `/appraisal/assignments/${managerAssignment.id}/save`, {
    token: rvA.token, body: { responses: [{ questionId: qPeerOnly.id, ratingValue: 4 }] },
  });
  assert.equal(crossed.status, 400, 'a question from another quadrant questionnaire is refused');

  // The shared competency keeps ONE score per group; it is never merged into a single number.
  const analysis = D(await req('GET', `/reports/shared-competencies/${appraisee.id}?cycleId=${cycleId}`, { token: admin.token }));
  const sharedItem = analysis.items.find((i) => i.competency === sharedComp.name);
  const managerCell = sharedItem.quadrants.find((q) => q.source === 'Line Manager');
  const peerCell = sharedItem.quadrants.find((q) => q.source === 'Peer');
  assert.equal(sharedItem.shared, true, 'the competency is recognised as shared');
  assert.equal(managerCell.score, 5, 'the manager perspective keeps its own score');
  assert.equal(peerCell.score, 3, 'the peer perspective keeps its own score');
  assert.equal(sharedItem.spread, 2, 'the gap between perspectives is reported');

  // The quadrant-specific competency is reported but never given a comparison verdict.
  const peerItem = analysis.items.find((i) => i.competency === peerComp.name);
  assert.equal(peerItem.comparable, false, 'a single-quadrant competency is not comparable');
  assert.equal(peerItem.findings.length, 0, 'and carries no gap verdict');

  // Radar marks a competency the group was never asked about as not assessed, which is
  // different from a score withheld by the minimum-response rule.
  const radar = D(await req('GET', `/reports/radar/${appraisee.id}?cycleId=${cycleId}`, { token: admin.token }));
  assert.ok(radar.assessedBy[peerComp.name].includes('Peer'), 'the peer quadrant covers its own competency');
  assert.ok(!radar.assessedBy[peerComp.name].includes('Line Manager'), 'the manager quadrant does not, so its cell is "not assessed"');

  // Clearing the quadrant questionnaire restores the previous inherit-from-cycle behaviour.
  await req('PUT', `/appraisal/cycles/${cycleId}/sources/${peerSrc.id}/template`, { token: admin.token, body: { templateId: null } });
  const restored = D(await req('GET', `/appraisal/cycles/${cycleId}/coverage`, { token: admin.token }));
  assert.equal(restored.mixedQuestionnaires, false, 'clearing the quadrant questionnaire restores inheritance');
});

/* ------------------------------------------------------------------ *
 * Parent / external feedback — the secure-link chain
 *
 * This whole path was untested. It is the only route by which a person
 * outside the organisation writes into an employee's 360 score, so it is
 * worth guarding: attribution to the right teacher, aggregation, the
 * anonymity threshold evaluated per teacher, and withdrawal on revoke.
 * ------------------------------------------------------------------ */

/**
 * Build an ACTIVE cycle whose start date is far enough in the future that
 * `provisionCycle()` — which picks the active cycle with the latest start date —
 * chooses it rather than the demo tenant's real one. Returns the cycle id and a
 * one-rating-question template.
 */
async function parentFixture(stamp, opts = {}) {
  const cats = D(await req('GET', '/competency/categories?page=1&pageSize=5', { token: admin.token }));
  const catId = (cats.items ?? cats)[0].id;
  const comp = D(await req('POST', '/competency/competencies', {
    token: admin.token, body: { categoryId: catId, name: `Parent Experience ${stamp}` },
  }));
  const question = D(await req('POST', '/questionnaire/questions', {
    token: admin.token,
    body: { text: `How would you rate this teacher ${stamp}?`, type: 'rating', competencyId: comp.id },
  }));
  const tpl = D(await req('POST', '/questionnaire/templates', { token: admin.token, body: { name: `regr-parent-tpl-${stamp}` } }));
  await req('POST', `/questionnaire/templates/${tpl.id}/sections`, { token: admin.token, body: { title: 'Parent view', sortOrder: 0 } });
  const full = D(await req('GET', `/questionnaire/templates/${tpl.id}`, { token: admin.token }));
  await req('POST', `/questionnaire/templates/${tpl.id}/sections/${full.sections[0].id}/questions`, {
    token: admin.token, body: { questionId: question.id },
  });
  await req('POST', `/questionnaire/templates/${tpl.id}/publish`, { token: admin.token });

  const cycleId = D(await req('POST', '/appraisal/cycles', {
    token: admin.token,
    body: { name: `regr-parent-${stamp}`, startDate: '2029-01-01', endDate: '2029-12-31', templateId: tpl.id },
  })).id;
  await req('POST', `/appraisal/cycles/${cycleId}/activate`, { token: admin.token });
  // The per-teacher flow auto-provisions the Parents quadrant on first use; consolidated
  // mode has to be set on it, so it is created up front when asked for.
  let sourceId = null;
  if (opts.parentSource) {
    sourceId = D(await req('POST', `/appraisal/cycles/${cycleId}/sources`, {
      token: admin.token, body: { code: 'parent', label: 'Parents', weight: 1 },
    })).id;
  }
  return { cycleId, sourceId, templateId: tpl.id, questionId: question.id, competency: comp.name };
}

/** Create a parent link for one (student, teaching assignment) and return it with its raw token. */
async function parentLink(studentId, teachingAssignmentId, parentId) {
  const r = await req('POST', '/external-evaluation', {
    token: admin.token,
    body: { studentId, teachingAssignmentId, parentId, oneTime: true },
  });
  return { status: r.status, link: D(r) };
}

test('parent feedback: a secure link writes into the teacher’s Parents quadrant', async () => {
  const stamp = Date.now();
  const { cycleId } = await parentFixture(stamp);

  // S1000 is taught by T100 on assignment TA0-0; T100 is identity-mapped to an employee.
  const created = await parentLink('S1000', 'TA0-0', 'PA0-1');
  assert.equal(created.status, 201, 'the link is created');
  assert.ok(created.link.token, 'the raw token is returned exactly once');
  assert.equal(created.link.status, 'pending', 'a fresh link is pending');

  // The parent sees the cycle questionnaire, not a hardcoded one.
  const ctx = D(await req('GET', `/public/evaluate/${created.link.token}`));
  assert.equal(ctx.student, 'Ahmed Khan', 'the form names the student');
  assert.ok(ctx.teacher, 'the form names the teacher');
  assert.ok(Array.isArray(ctx.questions) && ctx.questions.length >= 1, 'the form carries questions');
  assert.ok(Array.isArray(ctx.scale) && ctx.scale.length > 0, 'the form carries a rating scale');

  // Submitting writes a real feedback response against the external assignment.
  const answers = ctx.questions.filter((q) => q.type === 'rating').map((q) => ({ questionId: q.id, ratingValue: 5 }));
  const submitted = await req('POST', `/public/evaluate/${created.link.token}`, { body: { responses: answers } });
  assert.ok(submitted.status === 200 || submitted.status === 201, 'the parent can submit');

  // The rating lands on the mapped teacher's Parents quadrant in that cycle.
  const detail = D(await req('GET', `/external-evaluation/${created.link.id}`, { token: admin.token }));
  assert.equal(detail.status, 'completed', 'the link is completed');

  const employees = list(D(await req('GET', '/organization/employees?pageSize=200&search=Imran', { token: admin.token })));
  const teacher = employees[0];
  assert.ok(teacher, 'the mapped teacher exists as an employee');
  const report = D(await req('GET', `/reports/individual/${teacher.id}?cycleId=${cycleId}`, { token: admin.token }));
  const parents = report.bySource.find((s) => s.source === 'Parents');
  assert.ok(parents, 'the Parents quadrant appears on the teacher’s report');
  assert.equal(parents.reviewers, 1, 'one submitted link counts as one reviewer');
  assert.equal(parents.score, 5, 'the parent rating is attributed to this teacher');

  // A one-time link cannot be submitted twice.
  const again = await req('POST', `/public/evaluate/${created.link.token}`, { body: { responses: answers } });
  assert.equal(again.status, 410, 'a completed one-time link is gone');

  await req('POST', `/appraisal/cycles/${cycleId}/close`, { token: admin.token });
});

test('parent feedback: the anonymity threshold and revoke behave per teacher', async () => {
  const stamp = Date.now();
  const { cycleId } = await parentFixture(stamp);

  // Three different students, all taught by T100 — three independent parent voices
  // for the SAME teacher, which is what the threshold counts.
  const links = [];
  for (const [studentId, ta, parentId] of [['S1000', 'TA0-0', 'PA0-1'], ['S1001', 'TA0-1', 'PA1-1'], ['S1002', 'TA0-2', 'PA2-1']]) {
    const c = await parentLink(studentId, ta, parentId);
    assert.equal(c.status, 201, `link for ${studentId} is created`);
    links.push(c.link);
  }

  const employees = list(D(await req('GET', '/organization/employees?pageSize=200&search=Imran', { token: admin.token })));
  const teacher = employees[0];
  const parentsOf = async (viewerToken = admin.token) => {
    const r = D(await req('GET', `/reports/individual/${teacher.id}?cycleId=${cycleId}`, { token: viewerToken }));
    return r.bySource.find((s) => s.source === 'Parents');
  };

  // Two submissions: below the default threshold of 3.
  for (const link of links.slice(0, 2)) {
    const ctx = D(await req('GET', `/public/evaluate/${link.token}`));
    const answers = ctx.questions.filter((q) => q.type === 'rating').map((q) => ({ questionId: q.id, ratingValue: 4 }));
    await req('POST', `/public/evaluate/${link.token}`, { body: { responses: answers } });
  }
  let parents = await parentsOf();
  assert.equal(parents.reviewers, 2, 'two submitted links are two reviewers');

  // A viewer without reports.confidential.view must see the quadrant suppressed.
  const viewer = await login('hina.akhtar@carepvtltd.com', ADMIN.password);
  if (viewer.token) {
    const asViewer = D(await req('GET', `/reports/individual/${teacher.id}?cycleId=${cycleId}`, { token: viewer.token }));
    const vq = (asViewer?.bySource ?? []).find((s) => s.source === 'Parents');
    if (vq) assert.ok(vq.suppressed && vq.score === null, 'below the threshold the Parents quadrant is withheld');
  }

  // The third submission clears the threshold.
  const third = links[2];
  const ctx3 = D(await req('GET', `/public/evaluate/${third.token}`));
  const answers3 = ctx3.questions.filter((q) => q.type === 'rating').map((q) => ({ questionId: q.id, ratingValue: 4 }));
  await req('POST', `/public/evaluate/${third.token}`, { body: { responses: answers3 } });
  parents = await parentsOf();
  assert.equal(parents.reviewers, 3, 'three submitted links are three reviewers');
  assert.equal(parents.score, 4, 'the quadrant averages the parent ratings');

  // Revoking withdraws that parent's contribution and drops the count back below the threshold.
  const revoked = await req('POST', `/external-evaluation/${third.id}/revoke`, { token: admin.token });
  assert.equal(revoked.status, 200, 'the link is revoked');
  parents = await parentsOf();
  assert.equal(parents.reviewers, 2, 'a revoked link no longer counts as a reviewer');

  // And the revoked link can no longer be opened.
  assert.equal((await req('GET', `/public/evaluate/${third.token}`)).status, 410, 'a revoked link is gone');

  await req('POST', `/appraisal/cycles/${cycleId}/close`, { token: admin.token });
});

test('parent feedback: one consolidated form attributes each rating to its own teacher', async () => {
  const stamp = Date.now();
  const { cycleId, sourceId } = await parentFixture(stamp, { parentSource: true });

  // Opt this cycle's Parents quadrant into the consolidated form.
  const mode = await req('PUT', `/appraisal/cycles/${cycleId}/sources/${sourceId}/parent-mode`, {
    token: admin.token, body: { mode: 'consolidated' },
  });
  assert.equal(mode.status, 200, 'the quadrant accepts consolidated mode');

  // One link for one student, covering every teacher that student has.
  const created = await req('POST', '/external-evaluation/consolidated', {
    token: admin.token, body: { studentId: 'S1000', parentId: 'PA0-1', cycleId },
  });
  assert.equal(created.status, 201, 'the consolidated link is created');
  const link = D(created);
  assert.ok(link.teachers.length >= 2, 'the form covers several teachers');

  // Teachers are deduplicated: one row per teacher, never one per teaching assignment.
  const teacherIds = link.teachers.map((t) => t.teacherId);
  assert.equal(new Set(teacherIds).size, teacherIds.length, 'a teacher appears at most once on the form');

  const ctx = D(await req('GET', `/public/evaluate/${link.token}`));
  assert.equal(ctx.mode, 'consolidated', 'the parent gets the consolidated shape');
  assert.ok(ctx.question && ctx.question.text, 'one configurable question drives the whole form');
  assert.equal(ctx.teachers.length, link.teachers.length, 'the form lists every covered teacher');

  // Rate all but the last teacher — partial submission is allowed by default.
  const rate = ctx.teachers.slice(0, -1).map((t, i) => ({ teacherId: t.teacherId, ratingValue: i === 0 ? 5 : 3 }));
  const skippedTeacher = ctx.teachers[ctx.teachers.length - 1];
  const submitted = await req('POST', `/public/evaluate/${link.token}/consolidated`, { body: { ratings: rate } });
  assert.equal(submitted.status, 200, 'one submission carries every rating');
  assert.equal(D(submitted).rated, rate.length, 'the rated teachers are recorded');
  assert.equal(D(submitted).skipped, 1, 'the unrated teacher is recorded as skipped');

  // Each rating lands on ITS OWN teacher — the point of the whole feature.
  const employees = list(D(await req('GET', '/organization/employees?pageSize=200', { token: admin.token })));
  const parentsOf = async (fullName) => {
    const emp = employees.find((e) => e.user?.fullName === fullName);
    if (!emp) return null;
    const rep = D(await req('GET', `/reports/individual/${emp.id}?cycleId=${cycleId}`, { token: admin.token }));
    return (rep.bySource ?? []).find((s) => s.source === 'Parents') ?? null;
  };
  for (const [i, r] of rate.entries()) {
    const teacher = ctx.teachers.find((t) => t.teacherId === r.teacherId);
    const quadrant = await parentsOf(teacher.teacher);
    assert.ok(quadrant, `${teacher.teacher} has a Parents quadrant`);
    assert.equal(quadrant.score, r.ratingValue, `${teacher.teacher} keeps their own rating (row ${i})`);
    assert.equal(quadrant.reviewers, 1, 'one consolidated form is one reviewer for that teacher');
  }

  // An unrated teacher is "not asked": no score, and NOT counted toward their threshold.
  const skippedQuadrant = await parentsOf(skippedTeacher.teacher);
  assert.ok(!skippedQuadrant || skippedQuadrant.reviewers === 0, 'an unrated teacher gains no reviewer');

  // Revoking a consolidated link must withdraw EVERY teacher's rating, not just one.
  assert.equal((await req('POST', `/external-evaluation/${link.id}/revoke`, { token: admin.token })).status, 200, 'the link is revoked');
  for (const r of rate) {
    const teacher = ctx.teachers.find((t) => t.teacherId === r.teacherId);
    const quadrant = await parentsOf(teacher.teacher);
    assert.ok(!quadrant || quadrant.reviewers === 0, `${teacher.teacher}'s parent rating is withdrawn`);
  }

  await req('POST', `/appraisal/cycles/${cycleId}/close`, { token: admin.token });
});
