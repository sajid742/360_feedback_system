import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30s step) implemented on node:crypto so no
 * external OTP dependency is needed. Secrets are base32 (RFC 4648).
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const STEP_SECONDS = 30;

export function generateBase32Secret(byteLength = 20): string {
  return toBase32(randomBytes(byteLength));
}

export function otpauthUrl(secret: string, account: string, issuer = 'Enterprise360'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Verify a code within +/- `window` time steps to tolerate clock drift. */
export function verifyTotp(token: string, secretBase32: string, now: number, window = 1): boolean {
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const cleaned = token.replace(/\s/g, '');
  for (let offset = -window; offset <= window; offset += 1) {
    if (hotp(secretBase32, counter + offset) === cleaned) return true;
  }
  return false;
}

function hotp(secretBase32: string, counter: number): string {
  const key = fromBase32(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function fromBase32(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
