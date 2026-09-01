/**
 * run-ts.js — run a TypeScript maintenance script using the ts-node that is
 * INSTALLED IN THIS PROJECT.
 *
 * WHY THIS EXISTS. Every `db:*` script used to start with `npx ts-node`. When
 * ts-node is installed locally that is fine — npx finds it on PATH and runs it.
 * When it is NOT installed (a fresh unzip where `npm install` has not been run,
 * an install that skipped devDependencies because NODE_ENV=production was set,
 * or a partially-completed install), npx does something far worse than failing:
 * it silently downloads a copy of ts-node into the npm cache and runs THAT.
 * The downloaded copy has no `typescript` beside it, so it dies deep inside its
 * own config loader with a message that says nothing about the real problem:
 *
 *     TypeError: Cannot read properties of undefined (reading 'fileExists')
 *         at readConfig (…\npm-cache\_npx\…\ts-node\dist\configuration.js:91:33)
 *
 * The give-away is `_npx` in the path: the failing ts-node is not the project's.
 *
 * This runner removes that failure mode entirely. It resolves ts-node and
 * typescript from the project, and if either is missing it says so in one plain
 * sentence with the command that fixes it — instead of a stack trace from a
 * package the user never installed on purpose.
 *
 * It is also slightly faster than `npx ts-node`, because it registers ts-node
 * in-process rather than spawning a second Node.
 *
 *     node scripts/run-ts.js scripts/demo-data.ts --force
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Find a package inside THIS PROJECT's node_modules, walking up from the working
 * directory the way Node does (apps/api/node_modules, then the hoisted root).
 *
 * Deliberately not `require.resolve(dep, { paths })`: that still falls back to the
 * global folders and NODE_PATH, so a machine with `npm i -g ts-node` would report a
 * healthy project when the project itself has nothing installed — which is the exact
 * situation this file exists to diagnose. Returns the resolved entry point, or null.
 */
function resolveInProject(dep) {
  let dir = process.cwd();
  for (;;) {
    const pkgDir = path.join(dir, 'node_modules', dep);
    if (fs.existsSync(path.join(pkgDir, 'package.json'))) {
      try { return require.resolve(dep, { paths: [dir] }); } catch { return null; }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const target = process.argv[2];
if (!target) {
  console.error('run-ts.js: no script given. Usage: node scripts/run-ts.js <file.ts> [args…]');
  process.exit(1);
}

/**
 * Is this a DOCKER deployment folder rather than a from-source checkout?
 *
 * It matters because the advice differs completely. In Docker mode the whole point is
 * that no Node install exists on the host — so telling someone to run `npm install`
 * here is not just unhelpful, it sends them to set up a second, parallel installation
 * they never wanted. The tell is a folder that has `compose.yaml` and a live `.env`
 * (so the stack has been configured and started) but no `node_modules`.
 */
function looksLikeDockerDeployment() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const hasCompose = fs.existsSync(path.join(dir, 'compose.yaml')) || fs.existsSync(path.join(dir, 'docker-compose.yml'));
    if (hasCompose) {
      return { root: dir, configured: fs.existsSync(path.join(dir, '.env')), installed: fs.existsSync(path.join(dir, 'node_modules')) };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/* -- 1. the dependency check that npx should have done --------------------- */
const tsNodeEntry = resolveInProject('ts-node');
for (const [dep, found] of [['ts-node', tsNodeEntry], ['typescript', resolveInProject('typescript')]]) {
  if (!found) {
    const docker = looksLikeDockerDeployment();
    if (docker && docker.configured && !docker.installed) {
      // The likely case by far: a Docker user reaching for a from-source command.
      console.error(
        `\n  This looks like a DOCKER deployment, so ${path.basename(target)} should run inside the\n` +
        '  container rather than on this machine — the host has no Node dependencies\n' +
        '  installed, and does not need any.\n\n' +
        '  Seed or re-seed the demo data with:\n\n' +
        '      docker compose run --rm -e DEMO_RESEED=true db-init\n\n' +
        '  To check what the last initialisation actually did:\n\n' +
        '      docker compose logs db-init\n\n' +
        '  (If you did mean to run this from source, run "npm install" here first — but you\n' +
        '  would then be setting up a second installation alongside the Docker one.)\n',
      );
      process.exit(1);
    }
    console.error(
      `\n  Cannot run ${path.basename(target)}: "${dep}" is not installed in this copy of the project.\n\n` +
      '  This normally means dependencies have not been installed yet, or were\n' +
      '  installed without devDependencies. From the project root, run:\n\n' +
      '      npm install\n\n' +
      '  (or .\\deploy.ps1, which does this and the database setup together),\n' +
      '  then run this command again.\n\n' +
      '  If you have set NODE_ENV=production in your shell, unset it first —\n' +
      '  npm skips devDependencies when it is set, and ts-node is one of them.\n',
    );
    process.exit(1);
  }
}

/* -- 2. run the script ------------------------------------------------------ */
// Present argv exactly as `ts-node script.ts …` would, so scripts that read
// process.argv for their flags (--force, --slug, --dry-run) are unaffected.
const resolved = path.resolve(process.cwd(), target);
process.argv = [process.argv[0], resolved, ...process.argv.slice(3)];

// The project's ts-node, by the path resolved above — never a global one.
require(tsNodeEntry).register({ transpileOnly: true, cwd: process.cwd() });

// Load the target AS THE MAIN MODULE rather than with a plain require().
//
// This matters: purge-client.ts is both a library (new-client.ts imports
// `purgeClient` and `integrityReport` from it) and a command, and it tells the two
// apart with `if (require.main === module)`. Under a plain require() the main
// module would be this runner, that guard would be false, and the command would
// exit silently having done nothing — the worst possible outcome for a script
// whose job is to delete data. Making the target the main module reproduces
// exactly what `ts-node script.ts` does.
const Module = require('module');
const entry = new Module(resolved, null);
Module._cache[resolved] = entry;
process.mainModule = entry;
entry.load(resolved);
