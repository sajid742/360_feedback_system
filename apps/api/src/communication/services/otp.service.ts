import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProviderFactory } from '../providers/provider.factory';
import type { Channel } from '../providers/types';

const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** One-time passcodes: 6 digits, bcrypt-hashed at rest, 5-minute TTL. */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderFactory,
  ) {}

  async request(orgId: string, identifier: string, channel: Channel, purpose: string): Promise<{ sent: boolean }> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.prisma.otpCode.create({
      data: {
        organizationId: orgId,
        identifier,
        channel,
        purpose,
        codeHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });
    const provider = await this.providers.forChannel(orgId, channel);
    await provider.send({ recipient: identifier, subject: 'Your verification code', body: `Your code is ${code}` });
    return { sent: true };
  }

  async verify(orgId: string, identifier: string, purpose: string, code: string): Promise<{ valid: boolean }> {
    const row = await this.prisma.otpCode.findFirst({
      where: { organizationId: orgId, identifier, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.attempts >= MAX_ATTEMPTS) return { valid: false };

    if (!(await bcrypt.compare(code, row.codeHash))) {
      await this.prisma.otpCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      return { valid: false };
    }
    await this.prisma.otpCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    return { valid: true };
  }
}
