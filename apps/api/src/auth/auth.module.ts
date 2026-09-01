import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthSettingsService } from './auth.settings';
import { CommunicationModule } from '../communication/communication.module';
import { MustChangePasswordGuard } from '../common/auth/must-change-password.guard';
import { LoginService } from './services/login.service';
import { TokenService } from './services/token.service';
import { MfaService } from './services/mfa.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { CaptchaService } from './services/captcha.service';
import { SsoService } from './services/sso.service';
import { LdapService } from './services/ldap.service';

/**
 * Full Authentication module: credential login with lockout + captcha, TOTP MFA
 * with backup codes, rotating refresh tokens with reuse detection, session /
 * device management, password policy + history, and SSO (OIDC/OAuth2) + LDAP.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? 'change-me',
      signOptions: { expiresIn: process.env.JWT_ACCESS_TTL ?? '15m' },
    }),
    CommunicationModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthSettingsService,
    LoginService,
    TokenService,
    MfaService,
    PasswordService,
    SessionService,
    CaptchaService,
    SsoService,
    LdapService,
    // Global: enforce forced password change (server-side, independent of the UI).
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
  ],
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
