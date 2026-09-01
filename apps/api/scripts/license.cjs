#!/usr/bin/env node
/**
 * Vendor licence tooling — deliberately PLAIN JAVASCRIPT with ZERO dependencies.
 *
 *   npm run license:keygen                       generate a signing key pair (ONCE)
 *   npm run license:create  -- --org "…" …       issue a signed licence
 *   npm run license:inspect -- --file lic.txt    read a licence without verifying
 *   npm run license:verify  -- --file lic.txt    verify against the public key
 *
 * WHY PLAIN JS AND NOT TYPESCRIPT. These are the VENDOR's tools, and the vendor is
 * usually nowhere near a working development install: a Docker deployment folder has no
 * node_modules by design, and a laptop used only to mint licences has no reason to run
 * `npm install` on the whole monorepo. Written in TypeScript these needed ts-node, so
 * `npm run license:keygen` failed in exactly the situation it exists for. Everything
 * here uses Node's built-in crypto/fs/path, so it runs anywhere Node runs.
 *
 * IT MUST NEVER RUN INSIDE A CUSTOMER CONTAINER. The private key is the only thing that
 * can mint a licence; it belongs on the vendor's machine and nowhere else.
 *
 * THE SIGNING FORMAT IS SHARED with `src/license/license.crypto.ts`, which the server
 * uses to verify. The two are separate implementations of the same three-line format
 * (Ed25519 over the JSON payload, `E360-<b64url(body)>.<b64url(sig)>`). Change one and
 * you must change the other — the packaging check signs with this file and verifies with
 * the compiled server code, so any drift fails immediately rather than in the field.
 */
'use strict';

const { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const PREFIX = 'E360';

/* ------------------------------------------------------------------ format */

const b64url = (buf) => buf.toString('base64url');

function signLicense(payload, privateKeyPem) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  // Ed25519 takes no separate digest — `null` is correct, not an omission.
  const signature = sign(null, body, createPrivateKey(privateKeyPem));
  return `${PREFIX}-${b64url(body)}.${b64url(signature)}`;
}

function decodeUnsafe(licenseKey) {
  const t = String(licenseKey || '').trim().replace(/\s+/g, '');
  if (!t.startsWith(`${PREFIX}-`)) return null;
  const body = t.slice(PREFIX.length + 1).split('.')[0];
  if (!body) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function verifyLicense(licenseKey, publicKeyPem) {
  const t = String(licenseKey || '').trim().replace(/\s+/g, '');
  if (!t.startsWith(`${PREFIX}-`)) return { ok: false, reason: 'bad-prefix' };
  const [bodyPart, sigPart] = t.slice(PREFIX.length + 1).split('.');
  if (!bodyPart || !sigPart) return { ok: false, reason: 'bad-format' };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(bodyPart, 'base64url'), createPublicKey(publicKeyPem), Buffer.from(sigPart, 'base64url'));
  } catch {
    return { ok: false, reason: 'bad-key-or-encoding' };
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };
  const payload = decodeUnsafe(t);
  if (!payload) return { ok: false, reason: 'bad-payload' };
  return { ok: true, payload };
}

/* ------------------------------------------------------------------ config */

const LICENSED_MODULES = [
  'feedback', 'organization', 'reports', 'communication', 'parent_feedback',
  'sis_integration', 'hr_integration', 'ai_insights', 'api_access',
];

/** Starting points per edition. Every value is overridable on the command line. */
const EDITIONS = {
  trial:        { days: 30,  maxEmployees: 50,  modules: ['feedback', 'organization', 'reports'] },
  demo:         { days: 60,  maxEmployees: 100, modules: [...LICENSED_MODULES] },
  standard:     { days: 365, maxEmployees: 100, modules: ['feedback', 'organization', 'reports', 'communication'] },
  professional: { days: 365, maxEmployees: 500, modules: ['feedback', 'organization', 'reports', 'communication', 'parent_feedback', 'sis_integration', 'hr_integration'] },
  enterprise:   { days: 365, maxEmployees: 0,   modules: [...LICENSED_MODULES] },
};

/**
 * Default key location: a sibling of the project folder, never inside it.
 *
 * Walking up to the folder that holds compose.yaml (or the workspace package.json) means
 * this lands in the same place whether the command was run from the repo root or from
 * apps/api, which is where `npm run -w` puts you.
 */
function defaultKeyDir() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'compose.yaml')) || existsSync(join(dir, 'package-lock.json'))) {
      return join(dirname(dir), 'e360-license-keys');
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(process.cwd(), 'e360-license-keys');
}

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}
const has = (n) => argv.includes(`--${n}`);

/* ---------------------------------------------------------------- commands */

function keygen() {
  const dir = arg('out') || defaultKeyDir();
  mkdirSync(dir, { recursive: true });
  const pubPath = join(dir, 'license-public.pem');
  const privPath = join(dir, 'license-private.pem');
  if ((existsSync(pubPath) || existsSync(privPath)) && !has('force')) {
    throw new Error(
      `Keys already exist in ${dir}.\n` +
      '  Re-run with --force ONLY if you intend to invalidate every licence already issued.',
    );
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(pubPath, pub);
  writeFileSync(privPath, priv);
  try { chmodSync(privPath, 0o600); } catch { /* best effort on Windows */ }

  console.log(`\n  Key pair written to ${dir}\n`);
  console.log('  PUBLIC   license-public.pem   ships with the application');
  console.log('  PRIVATE  license-private.pem  keep OFF every server. Back it up. Never commit it.\n');
  console.log("  Put this line in each deployment's .env:\n");
  console.log(`  LICENSE_PUBLIC_KEY=${Buffer.from(pub).toString('base64')}\n`);
}

function create() {
  const keyDir = arg('keys') || defaultKeyDir();
  const privPath = arg('private-key') || join(keyDir, 'license-private.pem');
  if (!existsSync(privPath)) {
    throw new Error(
      `No signing key at ${privPath}.\n` +
      '  Run "npm run license:keygen" first, or pass --private-key <path>.',
    );
  }
  const org = arg('org');
  const slug = arg('slug');
  if (!org || !slug) {
    throw new Error(
      'Required: --org "ABC University" --slug abc\n\n' +
      '  Optional:\n' +
      '    --edition trial|demo|standard|professional|enterprise   (default professional)\n' +
      '    --employees 500      --users 50        --days 365\n' +
      '    --starts 2026-01-01  --expires 2026-12-31\n' +
      '    --license-id ABC-360-2026-0001         --grace-days 7\n' +
      `    --modules ${LICENSED_MODULES.slice(0, 3).join(',')}…\n` +
      '    --org-id <uuid>      --notes "…"       --out license.txt',
    );
  }
  const edition = arg('edition') || 'professional';
  const preset = EDITIONS[edition];
  if (!preset) throw new Error(`Unknown edition "${edition}". Use one of: ${Object.keys(EDITIONS).join(', ')}`);

  const now = new Date();
  const startsAt = arg('starts') ? new Date(`${arg('starts')}T00:00:00Z`) : now;
  const days = Number(arg('days') || preset.days);
  const expiresAt = arg('expires')
    ? new Date(`${arg('expires')}T23:59:59Z`)
    : new Date(startsAt.getTime() + days * 86400000);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(expiresAt.getTime())) throw new Error('Dates must be YYYY-MM-DD.');
  if (expiresAt <= startsAt) throw new Error('The expiry date must be after the start date.');

  const modulesArg = arg('modules');
  const modules = modulesArg
    ? modulesArg.split(',').map((m) => m.trim()).filter((m) => LICENSED_MODULES.includes(m))
    : preset.modules;
  if (modulesArg && modules.length === 0) {
    throw new Error(`No recognised modules in "${modulesArg}".\n  Valid: ${LICENSED_MODULES.join(', ')}`);
  }

  const payload = {
    v: 1,
    licenseId: arg('license-id') || `${slug.toUpperCase()}-360-${startsAt.getUTCFullYear()}-0001`,
    organizationName: org,
    organizationSlug: slug.toLowerCase(),
    ...(arg('org-id') ? { organizationId: arg('org-id') } : {}),
    edition,
    issuedAt: now.toISOString(),
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    maxEmployees: Number(arg('employees') != null ? arg('employees') : preset.maxEmployees),
    ...(arg('users') ? { maxUsers: Number(arg('users')) } : {}),
    modules,
    graceDays: Number(arg('grace-days') || 7),
    ...(arg('notes') ? { notes: arg('notes') } : {}),
  };

  const key = signLicense(payload, readFileSync(privPath, 'utf8'));
  print(payload);
  const out = arg('out');
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${key}\n`);
    console.log(`\n  Written to ${resolve(out)}\n`);
  } else {
    console.log('\n  LICENCE KEY — give this to the customer:\n');
    console.log(key);
    console.log('');
  }
}

function inspect() {
  const payload = decodeUnsafe(licenseArg());
  if (!payload) throw new Error('That does not look like a licence key.');
  console.log('\n  (decoded WITHOUT verifying — use license:verify to check the signature)');
  print(payload);
  console.log('');
}

function verifyCmd() {
  const pubPath = arg('public-key') || join(arg('keys') || defaultKeyDir(), 'license-public.pem');
  if (!existsSync(pubPath)) throw new Error(`No public key at ${pubPath}. Pass --public-key <path>.`);
  const result = verifyLicense(licenseArg(), readFileSync(pubPath, 'utf8'));
  if (!result.ok) {
    console.error(`\n  ✗ INVALID — ${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  console.log('\n  ✓ Signature valid');
  print(result.payload);
  const left = Math.ceil((Date.parse(result.payload.expiresAt) - Date.now()) / 86400000);
  console.log(`  ${left >= 0 ? `Expires in ${left} day(s)` : `EXPIRED ${Math.abs(left)} day(s) ago`}\n`);
}

function licenseArg() {
  const inline = arg('key');
  const file = arg('file');
  if (inline) return inline;
  if (file) return readFileSync(resolve(file), 'utf8').trim();
  throw new Error('Pass --key "E360-…" or --file <path>.');
}

function print(p) {
  const row = (k, v) => console.log(`    ${k.padEnd(18)}${v}`);
  console.log('\n  ──────────────────────────────────────────────');
  row('Organization', p.organizationName);
  row('Tenant (slug)', p.organizationSlug);
  row('Licence ID', p.licenseId);
  row('Edition', p.edition);
  row('Starts', String(p.startsAt).slice(0, 10));
  row('Expires', String(p.expiresAt).slice(0, 10));
  row('Max employees', p.maxEmployees ? String(p.maxEmployees) : 'unlimited');
  if (p.maxUsers) row('Max users', String(p.maxUsers));
  row('Grace period', `${p.graceDays == null ? 7 : p.graceDays} days`);
  row('Modules', (p.modules || []).join(', '));
  if (p.notes) row('Notes', p.notes);
  console.log('  ──────────────────────────────────────────────');
}

/* -------------------------------------------------------------------- main */

const COMMANDS = { keygen, create, inspect, verify: verifyCmd };

try {
  const cmd = argv.find((a) => COMMANDS[a]);
  if (!cmd) {
    console.log('\n  Licence tools — vendor use only. Run these on YOUR machine, never on a customer server.\n');
    console.log('    npm run license:keygen');
    console.log('    npm run license:create  -- --org "ABC University" --slug abc --edition professional');
    console.log('    npm run license:inspect -- --file license.txt');
    console.log('    npm run license:verify  -- --file license.txt\n');
    process.exitCode = 1;
  } else {
    COMMANDS[cmd]();
  }
} catch (e) {
  console.error(`\n  ✗ ${e.message}\n`);
  process.exitCode = 1;
}
