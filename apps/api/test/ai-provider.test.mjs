/**
 * AI provider configuration — black-box suite.
 *
 * Covers three things that were all broken or missing before:
 *
 *  1. `POST /configuration` answered 500 for EVERY module, because `value` carried no
 *     validation decorator and the global `ValidationPipe({whitelist:true})` stripped it
 *     before the service saw it. That is why the documented way to configure an external
 *     model could never have worked.
 *  2. The AI provider's API key was stored in the generic configuration store and read
 *     straight back by `GET /configuration?module=ai`, which needs only
 *     `configuration.read` — a permission HR/Admin holds by default.
 *  3. There was no way to tell whether a configured provider actually answers, and the
 *     fallback to the built-in engine is silent by design.
 *
 * A tiny OpenAI-compatible stub stands in for a real model, so the success path — a
 * provider that answers, and a narrative summary that comes back marked `ai` rather than
 * `heuristic` — is genuinely executed rather than asserted. No real model is called and
 * no key is used.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { req, login, D, ADMIN } from './helpers.mjs';

const STUB_PORT = Number(process.env.AI_STUB_PORT ?? 3998);
const STUB_URL = `http://127.0.0.1:${STUB_PORT}/v1`;

let admin;
let stub;
let skipReason = null;
/** Everything the stub was asked, so the test can inspect what left the building. */
const received = [];

/** An OpenAI-compatible `/chat/completions` stub. Loopback, so http is allowed. */
function startStub(port) {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => (raw += c));
    request.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* keep {} */
      }
      received.push({ url: request.url, auth: request.headers.authorization, body });
      const payload = Buffer.from(
        JSON.stringify({ choices: [{ message: { content: 'A stub summary written by the test model.' } }] }),
      );
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
      response.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  admin = await login(ADMIN.email, ADMIN.password);
  if (admin.status !== 200) {
    skipReason = 'the administrator could not sign in';
    return;
  }
  const probe = await req('GET', '/ai/provider', { token: admin.token });
  if (probe.status !== 200) {
    skipReason = `AI provider settings are not reachable (${probe.status}) — the plan may not include ai_insights`;
    return;
  }
  stub = await startStub(STUB_PORT);
});

after(async () => {
  // Never leave a provider configured on the demo tenant.
  if (admin?.token) await req('DELETE', '/ai/provider', { token: admin.token });
  if (stub) await new Promise((r) => stub.close(r));
});

/* ------------------------------------------------ the configuration API itself */

test('configuration: a value actually survives the request', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // The regression. Without a validation decorator on `value`, whitelist stripping made
  // this a 500 for every module in the application.
  const key = `regr-${Date.now()}`;
  const set = await req('POST', '/configuration', {
    token: admin.token,
    body: { module: 'regr-check', key, value: { nested: { deep: true }, list: [1, 2, 3] } },
  });
  assert.equal(set.status, 201, `a configuration value can be written: ${set.raw?.slice(0, 200)}`);
  assert.deepEqual(D(set).value, { nested: { deep: true }, list: [1, 2, 3] }, 'and is stored verbatim');

  const read = await req('GET', '/configuration?module=regr-check', { token: admin.token });
  const row = D(read).find((r) => r.key === key);
  assert.ok(row, 'and reads back');
  await req('DELETE', `/configuration/${row.id}`, { token: admin.token });
});

test('configuration: a missing value is a 400, not a 500', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await req('POST', '/configuration', {
    token: admin.token,
    body: { module: 'regr-check', key: 'no-value' },
  });
  assert.equal(r.status, 400, `got ${r.status}`);
});

/* ----------------------------------------------------------- the key is secret */

test('ai provider: the key cannot be read back through the configuration API', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const saved = await req('PUT', '/ai/provider', {
    token: admin.token,
    body: { baseUrl: STUB_URL, apiKey: 'sk-TEST-ONLY-SECRET-WXYZ', model: 'stub-model' },
  });
  assert.equal(saved.status, 200, saved.raw?.slice(0, 300));
  assert.equal(D(saved).configured, true);
  assert.equal(D(saved).apiKeyHint, '…WXYZ', 'only the last four characters come back');
  assert.equal(D(saved).apiKey, undefined, 'and never the key itself');

  // THE POINT: the generic configuration endpoint must not hand it over.
  const generic = await req('GET', '/configuration?module=ai', { token: admin.token });
  assert.equal(generic.status, 200);
  assert.equal(D(generic).length, 0, 'the ai module is invisible to the generic configuration endpoint');
  assert.equal(generic.raw.includes('sk-TEST-ONLY-SECRET'), false, 'the key appears nowhere in the response');

  // And it cannot be written there either, which would bypass the validation above.
  const write = await req('POST', '/configuration', {
    token: admin.token,
    body: { module: 'ai', key: 'provider', value: { apiKey: 'sk-sneaky' } },
  });
  assert.equal(write.status, 400, 'the ai module is reserved for writes too');
});

test('ai provider: saving without a key keeps the stored one', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // Changing a model name must not require re-typing a secret the screen cannot show.
  const r = await req('PUT', '/ai/provider', {
    token: admin.token,
    body: { baseUrl: STUB_URL, model: 'stub-model-2' },
  });
  assert.equal(r.status, 200, r.raw?.slice(0, 200));
  assert.equal(D(r).model, 'stub-model-2');
  assert.equal(D(r).apiKeyHint, '…WXYZ', 'the key is unchanged');
  assert.equal(D(r).configured, true, 'and the provider still works');
});

test('ai provider: http is refused on the public internet, allowed on a private network', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // Plain http to somewhere reachable from outside would put the key on the wire in
  // clear on every call.
  for (const bad of [
    'http://api.example.invalid/v1',
    'http://8.8.8.8:11434/v1',
    // Cloud metadata hands out instance credentials to anything that asks. No model
    // lives there, and `.internal` must not be the way in.
    'http://169.254.169.254/v1',
    'http://metadata.google.internal/v1',
  ]) {
    const r = await req('PUT', '/ai/provider', { token: admin.token, body: { baseUrl: bad, apiKey: 'sk-x' } });
    assert.equal(r.status, 400, `${bad} is refused (got ${r.status})`);
  }

  // Self-hosting is the answer for an organisation that cannot send staff names out, so
  // the addresses that shape actually uses have to work. None of these is routable from
  // the public internet. Under Docker `localhost` is the API container itself, which is
  // exactly why a container name and a private IP have to be accepted.
  for (const ok of [
    'http://localhost:11434/v1',
    'http://ollama:11434/v1',
    'http://host.docker.internal:11434/v1',
    'http://192.168.1.20:11434/v1',
    'http://10.0.0.5:11434/v1',
    'http://models.svc.cluster.local/v1',
  ]) {
    const r = await req('PUT', '/ai/provider', { token: admin.token, body: { baseUrl: ok, apiKey: 'sk-x' } });
    assert.equal(r.status, 200, `${ok} is accepted (got ${r.status}: ${r.raw?.slice(0, 160)})`);
  }

  // Put the stub back for the cases that follow.
  await req('PUT', '/ai/provider', {
    token: admin.token,
    body: { baseUrl: STUB_URL, apiKey: 'sk-TEST-ONLY-SECRET-WXYZ', model: 'stub-model' },
  });
});

test('ai provider: a first save with no key at all is refused', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await req('DELETE', '/ai/provider', { token: admin.token });
  const r = await req('PUT', '/ai/provider', { token: admin.token, body: { baseUrl: STUB_URL } });
  assert.equal(r.status, 400, 'there is nothing stored to fall back to');
  // Put it back for the cases below.
  await req('PUT', '/ai/provider', {
    token: admin.token,
    body: { baseUrl: STUB_URL, apiKey: 'sk-TEST-ONLY-SECRET-WXYZ', model: 'stub-model' },
  });
});

/* ------------------------------------------------------------ it actually works */

test('ai provider: the connection test reaches the model and reports success', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const before = received.length;
  const r = await req('POST', '/ai/provider/test', { token: admin.token });
  assert.equal(r.status, 200);
  assert.equal(D(r).ok, true, `the stub answered: ${JSON.stringify(D(r))}`);
  assert.ok(received.length > before, 'a real HTTP request was made');
  assert.match(received.at(-1).url, /\/v1\/chat\/completions$/, 'to the OpenAI-compatible path');
  assert.match(received.at(-1).auth ?? '', /^Bearer sk-TEST-ONLY-SECRET/, 'with the key as a bearer token');
});

test('ai provider: a turned-off provider is not used, and says so', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const off = await req('PUT', '/ai/provider', {
    token: admin.token,
    body: { baseUrl: STUB_URL, enabled: false },
  });
  assert.equal(off.status, 200);
  assert.equal(D(off).configured, false, 'settings kept, provider not in use');
  assert.equal(D(off).apiKeyHint, '…WXYZ', 'and the key is still stored');

  const status = await req('GET', '/ai/status', { token: admin.token });
  assert.equal(D(status).configured, false, 'the insights page falls back to the built-in engine');

  const test = await req('POST', '/ai/provider/test', { token: admin.token });
  assert.equal(D(test).ok, false);
  assert.match(D(test).detail, /turned off|not configured/i, 'and the test explains why');

  await req('PUT', '/ai/provider', { token: admin.token, body: { baseUrl: STUB_URL, enabled: true } });
});

test('ai provider: an unreachable provider falls back rather than failing', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // A port nothing is listening on. The fallback is the whole safety property: a wrong
  // provider must never break the screen.
  const r = await req('PUT', '/ai/provider', {
    token: admin.token,
    body: { baseUrl: 'http://127.0.0.1:3997/v1', apiKey: 'sk-TEST-ONLY-SECRET-WXYZ' },
  });
  assert.equal(r.status, 200, 'the settings save even though nothing is there');

  const t1 = await req('POST', '/ai/provider/test', { token: admin.token });
  assert.equal(t1.status, 200, 'the test itself does not error');
  assert.equal(D(t1).ok, false);
  assert.equal(
    /sk-TEST-ONLY-SECRET/.test(D(t1).detail ?? ''),
    false,
    'and the message never echoes the key back',
  );

  await req('PUT', '/ai/provider', { token: admin.token, body: { baseUrl: STUB_URL } });
});

test('ai insights: the summary is marked ai when a provider answers', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const employees = await req('GET', '/organization/employees?pageSize=5', { token: admin.token });
  const list = D(employees)?.items ?? D(employees) ?? [];
  if (list.length === 0) return t.skip('no employees in this tenant');

  // Find someone with enough feedback for a summary to be produced at all.
  let payload = null;
  for (const e of list) {
    const r = await req('GET', `/ai/insights/${e.id}`, { token: admin.token });
    if (r.status === 200 && D(r).hasData) {
      payload = D(r);
      break;
    }
  }
  if (!payload) return t.skip('no employee in this tenant has enough feedback for an insight');

  assert.equal(payload.generatedBy, 'ai', 'the narrative came from the model');
  assert.match(payload.summary, /stub summary/i, 'and it is the text the stub returned');

  // WHAT LEFT THE BUILDING. The screen promises comment text never goes out; this is
  // the assertion behind that promise.
  const sent = received.at(-1).body;
  const userMessage = sent.messages?.find((m) => m.role === 'user')?.content ?? '';
  assert.match(userMessage, /overallScore/, 'the computed facts are sent');
  assert.equal(/"text"\s*:/.test(userMessage), false, 'no comment text is sent');
  assert.equal(/@/.test(userMessage), false, 'no e-mail address is sent');
});

test('ai provider: removing it returns the tenant to the built-in engine', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await req('DELETE', '/ai/provider', { token: admin.token });
  assert.equal(r.status, 200);
  assert.equal(D(r).configured, false);
  assert.equal(D(r).apiKeyHint, null, 'the key is gone');
  assert.equal(D(await req('GET', '/ai/status', { token: admin.token })).configured, false);
});
