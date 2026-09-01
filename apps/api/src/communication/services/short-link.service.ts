import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommunicationSettingsService } from '../communication.settings';
import type { AuthUser } from '../../common/auth/current-user';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

@Injectable()
export class ShortLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CommunicationSettingsService,
  ) {}

  async create(user: AuthUser, targetUrl: string): Promise<Record<string, unknown>> {
    const code = await this.uniqueCode();
    const row = await this.prisma.shortLink.create({
      data: { organizationId: user.organizationId, code, targetUrl, createdBy: user.userId },
    });
    const base = (await this.settings.general(user.organizationId)).publicBaseUrl;
    return { id: row.id, code: row.code, targetUrl: row.targetUrl, shortUrl: `${base}/r/${row.code}`, clicks: 0 };
  }

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.shortLink.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ id: r.id, code: r.code, targetUrl: r.targetUrl, clicks: r.clicks }));
  }

  /** Resolve a code to its target and count the click. */
  async resolve(code: string): Promise<string> {
    const row = await this.prisma.shortLink.findUnique({ where: { code } });
    if (!row) throw new NotFoundException('Link not found.');
    await this.prisma.shortLink.update({ where: { code }, data: { clicks: { increment: 1 } } });
    return row.targetUrl;
  }

  private async uniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = Array.from(randomBytes(7), (b) => ALPHABET[b % ALPHABET.length]).join('');
      const clash = await this.prisma.shortLink.findUnique({ where: { code }, select: { id: true } });
      if (!clash) return code;
    }
    throw new Error('Could not generate a unique short code.');
  }
}
