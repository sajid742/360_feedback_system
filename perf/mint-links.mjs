/**
 * Mints parent evaluation links through the APPLICATION'S OWN API and writes the
 * plaintext tokens to a CSV for JMeter.
 *
 * This deliberately does NOT insert rows or forge token hashes directly in the
 * database. The links are created by POST /api/v1/external-evaluation exactly as an
 * administrator would, so the tokens under test are real tokens produced by the real
 * code path, and nothing about the token security model is bypassed.
 *
 * Output: perf/data/parent-tokens.csv  ->  token,studentId,teacherId
 *
 * Usage: PERF_CONFIRM=yes node perf/mint-links.mjs [count]
 */
const BASE = process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3000';
const COUNT = Number(process.argv[2] ?? 300);
const ORG = process.env.PERF_ORG_SLUG ?? 'care';
const EMAIL = process.env.PERF_ADMIN_EMAIL ?? 'perfadmin@carepvtltd.test';
const PASSWORD = process.env.PERF_ADMIN_PASSWORD ?? 'PerfTest!2026';

if (process.env.PERF_CONFIRM !== 'yes') {
  console.error('Refusing to run: set PERF_CONFIRM=yes (this creates evaluation links).');
  process.exit(1);
}

const api = async (path, opts = {}, token) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const main = async () => {
  const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ organizationSlug: ORG, email: EMAIL, password: PASSWORD }),
  });
  if (login.status !== 200 && login.status !== 201) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const token = login.body.data.accessToken;

  const students = await api('/sis/students?limit=400', {}, token);
  const list = students.body?.data?.items ?? students.body?.data ?? [];
  console.log(`students available: ${Array.isArray(list) ? list.length : 'n/a'}`);
  if (!Array.isArray(list) || list.length === 0) throw new Error('no students returned from /sis/students');

  const rows = ['token,studentId,teacherId'];
  let made = 0, skipped = 0;
  const started = Date.now();

  for (const s of list) {
    if (made >= COUNT) break;
    const teachers = await api(`/sis/students/${encodeURIComponent(s.id)}/teachers`, {}, token);
    const tl = teachers.body?.data ?? [];
    if (!Array.isArray(tl) || tl.length === 0) { skipped++; continue; }
    const parents = await api(`/sis/students/${encodeURIComponent(s.id)}/parents`, {}, token);
    const pl = parents.body?.data ?? [];
    const parentId = Array.isArray(pl) && pl[0] ? pl[0].id : undefined;

    for (const t of tl) {
      if (made >= COUNT) break;
      const created = await api('/external-evaluation', {
        method: 'POST',
        body: JSON.stringify({
          studentId: s.id,
          teachingAssignmentId: t.teachingAssignmentId,
          parentId,
          expiresInDays: 30,
          oneTime: false,   // re-readable, so a load test can GET the form repeatedly
          send: false,      // NEVER send: no WhatsApp/SMS/e-mail leaves the box
        }),
      }, token);
      if ((created.status === 200 || created.status === 201) && created.body?.data?.token) {
        rows.push(`${created.body.data.token},${s.id},${t.teacherId}`);
        made++;
      } else {
        skipped++;
        if (skipped <= 3) console.error(`  skip ${s.id}/${t.teacherId}: ${created.status} ${JSON.stringify(created.body?.message ?? created.body).slice(0, 140)}`);
      }
    }
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync('perf/data/parent-tokens.csv', rows.join('\n') + '\n');
  console.log(`minted ${made} links (${skipped} skipped) in ${((Date.now() - started) / 1000).toFixed(1)}s -> perf/data/parent-tokens.csv`);
};

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
