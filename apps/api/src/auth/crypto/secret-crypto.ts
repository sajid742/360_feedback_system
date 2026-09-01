import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * AES-256-GCM encryption for MFA secrets at rest. Key comes from
 * MFA_ENCRYPTION_KEY (exactly 64 hex chars → 32 bytes). Output is
 * base64(iv[12] | authTag[16] | ciphertext).
 */
function key(): Buffer {
  const hex = process.env.MFA_ENCRYPTION_KEY ?? '';
  if (hex.length !== 64) {
    throw new Error('MFA_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** SHA-256 hex — used to store refresh tokens and device fingerprints. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
