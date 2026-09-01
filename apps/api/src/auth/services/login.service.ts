import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthSettingsService } from '../auth.settings';
import { CaptchaService } from './captcha.service';
import { MfaService } from './mfa.service';
import { TokenService, type IssuedTokens, type SessionContext } from './token.service';
import type { LoginDto, MfaLoginDto } from '../auth.dto';

export type LoginResponse = IssuedTokens | { mfaRequired: true; mfaToken: string };

@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly settings: AuthSettingsService,
    private readonly captcha: CaptchaService,
    private readonly mfa: MfaService,
    private readonly tokens: TokenService,
  ) {}

  async login(dto: LoginDto, ctx: SessionContext, now: number): Promise<LoginResponse> {
    const org = await this.prisma.organization.findFirst({
      where: { slug: dto.organizationSlug, deletedAt: null },
      select: { id: true },
    });
    if (!org) throw new UnauthorizedException('Invalid organization or credentials.');

    if (!(await this.captcha.verify(org.id, dto.captchaToken))) {
      throw new ForbiddenException('Captcha verification failed.');
    }
    await this.assertNotLockedOut(org.id, dto.email, now);

    const user = await this.prisma.user.findFirst({
      where: { organizationId: org.id, email: dto.email.toLowerCase(), deletedAt: null, status: 'active' },
      select: { id: true, organizationId: true, email: true, fullName: true, passwordHash: true },
    });
    if (!user?.passwordHash || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      await this.record(org.id, dto.email, false, 'bad_credentials', ctx.ip);
      throw new UnauthorizedException('Invalid organization or credentials.');
    }
    await this.record(org.id, dto.email, true, null, ctx.ip);

    if (await this.mfa.isEnabled(user.id)) {
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, organizationId: user.organizationId, purpose: 'mfa' },
        { expiresIn: '5m' },
      );
      return { mfaRequired: true, mfaToken };
    }
    return this.tokens.issueSession(
      { id: user.id, organizationId: user.organizationId, email: user.email, fullName: user.fullName },
      ctx,
    );
  }

  async completeMfa(dto: MfaLoginDto, ctx: SessionContext, now: number): Promise<IssuedTokens> {
    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; purpose: string }>(dto.mfaToken);
      if (payload.purpose !== 'mfa') throw new Error('wrong purpose');
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException('MFA session expired. Sign in again.');
    }
    if (!(await this.mfa.verify(userId, dto.code, now))) {
      throw new UnauthorizedException('Invalid authentication code.');
    }
    const user = await this.prisma.user.findFirstOrThrow({
      where: { id: userId, deletedAt: null },
      select: { id: true, organizationId: true, email: true, fullName: true },
    });
    return this.tokens.issueSession(user, ctx);
  }

  private async assertNotLockedOut(orgId: string, email: string, now: number): Promise<void> {
    const policy = await this.settings.lockout(orgId);
    const windowStart = new Date(now - policy.windowMinutes * 60_000);
    const failures = await this.prisma.loginAttempt.count({
      where: { organizationId: orgId, email: email.toLowerCase(), success: false, createdAt: { gte: windowStart } },
    });
    if (failures >= policy.maxAttempts) {
      throw new ForbiddenException('Account temporarily locked due to failed attempts. Try again later.');
    }
  }

  private async record(
    orgId: string,
    email: string,
    success: boolean,
    reason: string | null,
    ip: string | null,
  ): Promise<void> {
    await this.prisma.loginAttempt.create({
      data: { organizationId: orgId, email: email.toLowerCase(), success, reason, ip },
    });
  }
}
