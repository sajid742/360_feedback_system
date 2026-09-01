import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/auth/current-user';
import { decryptSecret, encryptSecret } from '../crypto/secret-crypto';
import { generateBase32Secret, otpauthUrl, verifyTotp } from '../crypto/totp';

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
}

@Injectable()
export class MfaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Generates (or resets) a not-yet-enabled secret and returns provisioning data. */
  async setup(user: AuthUser): Promise<MfaSetup> {
    const secret = generateBase32Secret();
    await this.prisma.mfaSecret.upsert({
      where: { userId: user.userId },
      update: { encryptedSecret: encryptSecret(secret), enabled: false },
      create: { userId: user.userId, encryptedSecret: encryptSecret(secret), enabled: false },
    });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** Confirms the first code, enables MFA, and returns one-time backup codes. */
  async enable(user: AuthUser, code: string, now: number): Promise<string[]> {
    const record = await this.prisma.mfaSecret.findUnique({ where: { userId: user.userId } });
    if (!record) throw new NotFoundException('Start MFA setup first.');
    if (!verifyTotp(code, decryptSecret(record.encryptedSecret), now)) {
      throw new BadRequestException('Invalid authentication code.');
    }
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex'));
    await this.prisma.$transaction([
      this.prisma.mfaSecret.update({ where: { id: record.id }, data: { enabled: true } }),
      this.prisma.mfaBackupCode.deleteMany({ where: { mfaSecretId: record.id } }),
    ]);
    await this.prisma.mfaBackupCode.createMany({
      data: await Promise.all(
        codes.map(async (c) => ({ mfaSecretId: record.id, codeHash: await bcrypt.hash(c, 10) })),
      ),
    });
    return codes;
  }

  async disable(user: AuthUser): Promise<void> {
    await this.prisma.mfaSecret.deleteMany({ where: { userId: user.userId } });
  }

  async isEnabled(userId: string): Promise<boolean> {
    const record = await this.prisma.mfaSecret.findUnique({ where: { userId }, select: { enabled: true } });
    return record?.enabled ?? false;
  }

  /** Verifies a TOTP code, or consumes a one-time backup code. */
  async verify(userId: string, code: string, now: number): Promise<boolean> {
    const record = await this.prisma.mfaSecret.findUnique({
      where: { userId },
      include: { backupCodes: { where: { usedAt: null } } },
    });
    if (!record?.enabled) return false;
    if (verifyTotp(code, decryptSecret(record.encryptedSecret), now)) return true;
    for (const backup of record.backupCodes) {
      if (await bcrypt.compare(code, backup.codeHash)) {
        await this.prisma.mfaBackupCode.update({ where: { id: backup.id }, data: { usedAt: new Date() } });
        return true;
      }
    }
    return false;
  }
}
