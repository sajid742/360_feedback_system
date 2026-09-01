import { randomInt } from 'node:crypto';

/**
 * Generate a strong temporary password that satisfies any reasonable policy.
 * Shared by the admin password-reset flow and by employee provisioning (F-C1),
 * so newly created people always get a usable credential instead of a null hash.
 */
export function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#$%^&*?';
  const all = upper + lower + digit + symbol;
  const pick = (set: string): string => set[randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)];
  while (chars.length < 14) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
