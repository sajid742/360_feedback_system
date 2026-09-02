#!/usr/bin/env node
/**
 * Stamp the build-time licensing constants into src/license/build-config.ts.
 *
 *   node apps/api/scripts/write-build-config.cjs --channel customer --key <base64 PEM> [--id <build id>]
 *   node apps/api/scripts/write-build-config.cjs --channel internal
 *
 * Run inside the Docker BUILD STAGE, on the copy of the source in the image — your
 * working tree is not modified by a release build.
 *
 * PLAIN JAVASCRIPT, ZERO DEPENDENCIES, for the same reason as the licence tool: it has to
 * run before `npm ci` has necessarily produced anything useful, and inside a build stage
 * where nothing but Node can be assumed.
 *
 * THE SAFETY RULE THIS ENFORCES: a `customer` or `test` build MUST be given a trusted
 * public key. Shipping a customer build with an empty key would reject every licence the
 * customer owns — a silent, total outage on their site. The script refuses instead.
 *
 * The key here is a PUBLIC key. Never pass a private key to this script; it belongs
 * nowhere near a build.
 */
'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const TARGET = resolve(__dirname, '..', 'src', 'license', 'build-config.ts');
const CHANNELS = ['internal', 'test', 'customer'];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(`\n  write-build-config: ${message}\n`);
  process.exit(1);
}

const channel = String(arg('channel', 'internal')).trim();
const id = String(arg('id', channel === 'internal' ? 'dev' : new Date().toISOString().slice(0, 10))).trim();

if (!CHANNELS.includes(channel)) {
  fail(`unknown channel "${channel}". Expected one of: ${CHANNELS.join(', ')}.`);
}

let source = readFileSync(TARGET, 'utf8');

// An omitted --key KEEPS the key already stamped into the file. That is what lets a
// customer rebuild the image from a release package without being handed the key
// separately: the release stamped it once, and a rebuild inherits it.
const existingKey = (source.match(/export const TRUSTED_PUBLIC_KEY_B64 = '([^']*)';/) || [, ''])[1];
const key = String(arg('key', '')).trim() || existingKey;

// A shipped build with no key would reject every licence in the field.
if (channel !== 'internal' && !key) {
  fail(
    `a "${channel}" build needs --key <base64-encoded public key PEM>.\n` +
    `  Get it from your key folder:  node tools/license.cjs keygen   (prints the one-line value)\n` +
    `  Without it this build would refuse every licence you have issued.`,
  );
}

// Reject anything that even looks like a private key, loudly, before it can be baked in.
if (key) {
  let decoded = '';
  try { decoded = Buffer.from(key, 'base64').toString('utf8'); } catch { /* not base64 */ }
  const looksPrivate = /PRIVATE KEY/.test(key) || /PRIVATE KEY/.test(decoded);
  if (looksPrivate) fail('that is a PRIVATE key. Only the PUBLIC key may be built into the application.');
  const looksPublic = /BEGIN PUBLIC KEY/.test(key) || /BEGIN PUBLIC KEY/.test(decoded);
  if (!looksPublic) fail('--key does not look like a public key PEM (raw or base64-encoded).');
}

const replacements = [
  [/export const BUILD_CHANNEL = '[^']*' as BuildChannel;/, `export const BUILD_CHANNEL = '${channel}' as BuildChannel;`],
  [/export const TRUSTED_PUBLIC_KEY_B64 = '[^']*';/, `export const TRUSTED_PUBLIC_KEY_B64 = '${key}';`],
  [/export const BUILD_ID = '[^']*';/, `export const BUILD_ID = '${id}';`],
];

for (const [pattern, next] of replacements) {
  if (!pattern.test(source)) {
    fail(`could not find the generated block in ${TARGET}. Did the file's shape change?`);
  }
  source = source.replace(pattern, next);
}

// Re-stamping the same values is legitimate (a rebuild of an already-stamped release),
// so an unchanged file is success, not failure. The guard that matters is above: every
// pattern must have matched, or the file's shape has drifted and we stop.
writeFileSync(TARGET, source, 'utf8');

console.log(`  build channel : ${channel}`);
console.log(`  build id      : ${id}`);
console.log(`  trusted key   : ${key ? `set (${key.length} chars)` : 'none (development only)'}`);
