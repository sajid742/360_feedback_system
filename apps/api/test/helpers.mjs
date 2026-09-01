import http from 'node:http';
const BASE = process.env.API_BASE ?? 'http://localhost:3000/api/v1';
export function req(method, path, { token, body, headers, base } = {}) {
  return new Promise((resolve) => {
    const url = new URL((base || BASE) + path);
    const data = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { 'Content-Type': 'application/json', ...(headers || {}) };
    if (token) h['Authorization'] = 'Bearer ' + token;
    if (data) h['Content-Length'] = data.length;
    const r = http.request(url, { method, headers: h }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json, raw: buf, headers: res.headers }); });
    });
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}
export async function login(email, password, slug = 'care') {
  const r = await req('POST', '/auth/login', { body: { organizationSlug: slug, email, password } });
  const d = r.json && r.json.data;
  return { status: r.status, token: d && d.accessToken, user: d && d.user, raw: r.json };
}
export const D = (r) => r.json && ('data' in r.json ? r.json.data : r.json);
export const ADMIN = { email: process.env.TEST_ADMIN_EMAIL ?? 'sajidq@carepvtltd.com', password: process.env.TEST_ADMIN_PASSWORD ?? 'Password123!' };
