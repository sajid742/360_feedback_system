import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { LicensePayload } from './license.types';

/**
 * Licence signing and verification.
 *
 * ALGORITHM: Ed25519, via Node's built-in `crypto`. Chosen over RSA or a JWT library
 * for three reasons that matter here: it needs no dependency at all, its keys and
 * signatures are small enough that a licence stays a paste-able string, and it has no
 * algorithm-negotiation step — so there is no "alg: none" class of mistake to get wrong.
 *
 * KEY HANDLING: the application ships only the PUBLIC key and can therefore only ever
 * verify. The private key exists solely where the vendor generates licences, is never
 * read by the server, and is never logged. `npm run license:keygen` writes it outside
 * the repository by default.
 *
 * FORMAT: `E360-<base64url(payload JSON)>.<base64url(signature)>`. Self-describing,
 * copy-pasteable, and the payload is deliberately readable — a licence is not a secret,
 * it is a signed claim. Tampering with the readable part invalidates the signature,
 * which is the entire point.
 */

const PREFIX = 'E360';

/**
 * The vendor's public key, PEM, base64-encoded so it survives an .env file on one line.
 *
 * Overridable with LICENSE_PUBLIC_KEY so you can rotate keys or run your own build
 * without editing source. The placeholder below is intentionally NOT a real key: an
 * installation that has not been given one refuses every licence rather than silently
 * accepting anything, and development mode covers the local workflow.
 */
const EMBEDDED_PUBLIC_KEY_B64 = '';

export function publicKeyPem(): string | null {
  const raw = (process.env.LICENSE_PUBLIC_KEY ?? EMBEDDED_PUBLIC_KEY_B64).trim();
  if (!raw) return null;
  // Accept either a raw PEM (with real newlines or \n escapes) or base64 of one.
  if (raw.includes('BEGIN PUBLIC KEY')) return raw.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return decoded.includes('BEGIN PUBLIC KEY') ? decoded : null;
  } catch {
    return null;
  }
}

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Vendor-side only. Never called by the server. */
export function generateLicenseKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const b64url = (b: Buffer): string => b.toString('base64url');

/** Vendor-side only. */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const key = createPrivateKey(privateKeyPem);
  // Ed25519 takes no separate digest — `null` is correct, not an omission.
  const signature = sign(null, body, key);
  return `${PREFIX}-${b64url(body)}.${b64url(signature)}`;
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: string };

/**
 * Verify a licence string. Structural failures and signature failures are reported
 * separately in the logs but collapse to one administrator-facing message upstream,
 * so a probe cannot use the difference to learn anything.
 */
export function verifyLicense(licenseKey: string, pem?: string | null): VerifyResult {
  const key = pem ?? publicKeyPem();
  if (!key) return { ok: false, reason: 'no-public-key' };

  const trimmed = (licenseKey ?? '').trim().replace(/\s+/g, '');
  if (!trimmed.startsWith(`${PREFIX}-`)) return { ok: false, reason: 'bad-prefix' };

  const [bodyPart, sigPart] = trimmed.slice(PREFIX.length + 1).split('.');
  if (!bodyPart || !sigPart) return { ok: false, reason: 'bad-format' };

  let body: Buffer;
  let signature: Buffer;
  try {
    body = Buffer.from(bodyPart, 'base64url');
    signature = Buffer.from(sigPart, 'base64url');
  } catch {
    return { ok: false, reason: 'bad-encoding' };
  }

  let valid = false;
  try {
    valid = verify(null, body, createPublicKey(key), signature);
  } catch {
    return { ok: false, reason: 'bad-key' };
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(body.toString('utf8')) as LicensePayload;
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }
  if (payload.v !== 1) return { ok: false, reason: 'unsupported-version' };
  if (!payload.organizationSlug || !payload.expiresAt || !payload.licenseId) {
    return { ok: false, reason: 'incomplete-payload' };
  }
  return { ok: true, payload };
}

/** Read a licence without checking it — for the vendor's `license:inspect`. */
export function decodeLicenseUnsafe(licenseKey: string): LicensePayload | null {
  const trimmed = (licenseKey ?? '').trim().replace(/\s+/g, '');
  const body = trimmed.startsWith(`${PREFIX}-`) ? trimmed.slice(PREFIX.length + 1).split('.')[0] : '';
  if (!body) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LicensePayload;
  } catch {
    return null;
  }
}
