/**
 * Unit test for channel-aware recipient selection on parent evaluation links.
 *
 * Imports the compiled helpers directly, so run `npm run -w apps/api build` first.
 * No API or database needed.
 *
 * The defect being pinned: the recipient used to be resolved once, at link creation,
 * as `whatsapp ?? mobile ?? email`. Because almost every guardian has a phone number,
 * that produced a phone number — which was then reused whatever channel was chosen
 * later. Sending by e-mail put "+923155272172" in the To: header and SMTP answered
 * "No recipients defined", naming neither the address nor the cause.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  contactForChannel,
  assertRecipientShape,
} from '../dist/external-evaluation/services/evaluation-link.service.js';

const fullyContactable = {
  mobile: '+923001112222',
  whatsapp: '+923155272172',
  email: 'guardian@example.test',
};

test('e-mail picks the e-mail address, never the phone (the reported bug)', () => {
  assert.equal(contactForChannel('email', fullyContactable), 'guardian@example.test');
});

test('whatsapp prefers the whatsapp number, then the mobile', () => {
  assert.equal(contactForChannel('whatsapp', fullyContactable), '+923155272172');
  assert.equal(
    contactForChannel('whatsapp', { mobile: '+923001112222', whatsapp: null, email: 'g@example.test' }),
    '+923001112222',
  );
});

test('sms prefers the mobile, then the whatsapp number', () => {
  assert.equal(contactForChannel('sms', fullyContactable), '+923001112222');
  assert.equal(
    contactForChannel('sms', { mobile: null, whatsapp: '+923155272172', email: 'g@example.test' }),
    '+923155272172',
  );
});

test('e-mail never falls back to a phone number when no e-mail is on record', () => {
  // Returning null is the point: the caller then raises a message naming the missing
  // contact detail, instead of handing a phone number to an SMTP server.
  assert.equal(contactForChannel('email', { mobile: '+923001112222', whatsapp: '+923155272172', email: null }), null);
  assert.equal(contactForChannel('email', { mobile: '+923001112222', whatsapp: null, email: '   ' }), null);
});

test('phone channels never fall back to an e-mail address', () => {
  assert.equal(contactForChannel('whatsapp', { mobile: null, whatsapp: null, email: 'g@example.test' }), null);
  assert.equal(contactForChannel('sms', { mobile: null, whatsapp: null, email: 'g@example.test' }), null);
});

test('blank and whitespace-only contact details count as missing', () => {
  assert.equal(contactForChannel('email', { email: '' }), null);
  assert.equal(contactForChannel('whatsapp', { whatsapp: '  ', mobile: '' }), null);
});

// ---------------------------------------------------------------------------
// The shape guard: what turns an opaque provider failure into a usable message.
// ---------------------------------------------------------------------------

test('a phone number sent on the e-mail channel is refused, with the value named', () => {
  assert.throws(
    () => assertRecipientShape('email', '+923155272172'),
    (err) => {
      assert.match(err.message, /\+923155272172/, 'the message must name the offending value');
      assert.match(err.message, /not an e-mail address/i);
      assert.match(err.message, /Students & Parents/, 'the message must say where to fix it');
      return true;
    },
  );
});

test('an e-mail address sent on a phone channel is refused', () => {
  assert.throws(() => assertRecipientShape('whatsapp', 'guardian@example.test'), /not a phone number/i);
  assert.throws(() => assertRecipientShape('sms', 'guardian@example.test'), /not a phone number/i);
});

test('valid pairings pass', () => {
  assertRecipientShape('email', 'guardian@example.test');
  assertRecipientShape('email', '  guardian@example.test  ');
  assertRecipientShape('whatsapp', '+923155272172');
  assertRecipientShape('sms', '03001112222');
});

test('an address with no domain dot is refused rather than sent', () => {
  assert.throws(() => assertRecipientShape('email', 'guardian@localhost'), /not an e-mail address/i);
});
