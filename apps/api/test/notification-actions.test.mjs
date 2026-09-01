import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Actionable vs informational notifications.
 *
 * Unlike api.e2e.test.mjs this needs no running server and no database: the rule it
 * covers is a pure function, and that is the point — actionability is decided in ONE
 * place, so it can be tested in one place.
 *
 * Requires a build first (`npm run -w apps/api build`), because the compiled module is
 * what the server actually runs. Without dist the suite skips rather than fails, so it
 * never breaks a checkout that has not been built.
 */
const here = dirname(fileURLToPath(import.meta.url));
const distModule = resolve(here, '../dist/user-notifications/notification-actions.js');
const built = existsSync(distModule);

let resolveNotificationAction;
let ACTIONABLE_NOTIFICATION_TYPES;

before(async () => {
  if (!built) return;
  const mod = await import(pathToFileURL(distModule).href);
  const m = mod.default && mod.resolveNotificationAction === undefined ? mod.default : mod;
  resolveNotificationAction = m.resolveNotificationAction;
  ACTIONABLE_NOTIFICATION_TYPES = m.ACTIONABLE_NOTIFICATION_TYPES;
});

describe('notification actions', { skip: built ? false : 'apps/api not built — run `npm run -w apps/api build`' }, () => {
  // A user who can open /appraisal, and one who cannot.
  const CAN = ['appraisal.read', 'reports.read'];
  const CANNOT = ['reports.read'];

  describe('actionable', () => {
    for (const type of ['cycle_started', 'feedback_reminder', 'final_reminder']) {
      test(`${type} resolves to the appraisal page`, () => {
        const action = resolveNotificationAction(type, CAN);
        assert.ok(action, `${type} must be actionable for a user with appraisal.read`);
        assert.equal(action.route, '/appraisal');
        assert.ok(action.label.length > 0, 'an action needs a label for its affordance');
      });
    }

    test('every actionable route is an internal path, never an external URL', () => {
      for (const type of ACTIONABLE_NOTIFICATION_TYPES) {
        const { route } = resolveNotificationAction(type, CAN);
        assert.ok(route.startsWith('/'), `${type}: route must be absolute`);
        assert.ok(!route.startsWith('//'), `${type}: protocol-relative route would leave the app`);
      }
    });
  });

  describe('informational — never clickable', () => {
    for (const type of ['feedback_submitted', 'cycle_closed', 'admin_message']) {
      test(`${type} has no action`, () => {
        assert.equal(resolveNotificationAction(type, CAN), null);
      });
    }
  });

  describe('permissions are checked against the viewer', () => {
    for (const type of ['cycle_started', 'feedback_reminder', 'final_reminder']) {
      test(`${type} is not actionable without appraisal.read`, () => {
        assert.equal(resolveNotificationAction(type, CANNOT), null,
          'a notification must never be clickable to a page the viewer cannot open');
      });
    }
  });

  describe('edge cases degrade to informational, never to an error', () => {
    const cases = [
      ['an unknown/newer type', 'some_future_event', CAN],
      ['a historical row with no type', null, CAN],
      ['undefined type', undefined, CAN],
      ['an empty type', '', CAN],
      ['a token with no permissions claim', 'cycle_started', null],
      ['undefined permissions', 'cycle_started', undefined],
      ['an empty permission list', 'cycle_started', []],
      // The lookup must not walk Object.prototype.
      ['type "constructor"', 'constructor', CAN],
      ['type "__proto__"', '__proto__', CAN],
      ['type "toString"', 'toString', CAN],
    ];
    for (const [label, type, permissions] of cases) {
      test(label, () => {
        assert.equal(resolveNotificationAction(type, permissions), null);
      });
    }
  });
});
