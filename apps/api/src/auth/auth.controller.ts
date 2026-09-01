import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { AuthSettingsService, type MfaPolicy } from './auth.settings';

class MfaPolicyDto {
  @IsIn(['optional', 'required_admins', 'required_all']) mode!: MfaPolicy['mode'];
}

/** Typed password-policy body (F2). Every field optional — a partial update merges. */
class PasswordPolicyDto {
  @IsOptional() @IsInt() @Min(6) @Max(64) minLength?: number;
  @IsOptional() @IsBoolean() requireUpper?: boolean;
  @IsOptional() @IsBoolean() requireLower?: boolean;
  @IsOptional() @IsBoolean() requireNumber?: boolean;
  @IsOptional() @IsBoolean() requireSymbol?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(24) historyCount?: number;
}

/** Typed lockout-policy body (F2). */
class LockoutPolicyDto {
  @IsOptional() @IsInt() @Min(3) @Max(20) maxAttempts?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1440) windowMinutes?: number;
}
import { sha256 } from './crypto/secret-crypto';
import type { SessionContext } from './services/token.service';
import { LoginService } from './services/login.service';
import { TokenService } from './services/token.service';
import { MfaService } from './services/mfa.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { SsoService } from './services/sso.service';
import { LdapService } from './services/ldap.service';
import {
  ChangePasswordDto,
  LdapLoginDto,
  LoginDto,
  MfaEnableDto,
  MfaLoginDto,
  RefreshDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SetInitialPasswordDto,
} from './auth.dto';

function toSessionContext(ctx: RequestContext): SessionContext {
  return {
    ip: ctx.ip,
    userAgent: ctx.device,
    deviceHash: ctx.device ? sha256(ctx.device) : null,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginService: LoginService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly sso: SsoService,
    private readonly ldap: LdapService,
    private readonly settings: AuthSettingsService,
  ) {}

  /* ---- Organisation MFA policy (F8, security admin) ---- */
  @Get('mfa/policy')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('security.rbac.manage')
  getMfaPolicy(@CurrentUser() user: AuthUser) {
    return this.settings.mfaPolicy(user.organizationId);
  }

  @Put('mfa/policy')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('security.rbac.manage')
  setMfaPolicy(@CurrentUser() user: AuthUser, @Body() dto: MfaPolicyDto) {
    return this.settings.setMfaPolicy(user.organizationId, user.userId, dto.mode);
  }

  /* ---- Organisation security policy (F2, security admin) ----
   * The password and lockout rules were already enforced at runtime but had no
   * typed endpoint, so an administrator could only change them through the raw
   * key/value configuration store. These make them a first-class setting.       */
  @Get('security-policy')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('security.rbac.manage')
  async getSecurityPolicy(@CurrentUser() user: AuthUser) {
    const [password, lockout, mfa] = await Promise.all([
      this.settings.passwordPolicy(user.organizationId),
      this.settings.lockout(user.organizationId),
      this.settings.mfaPolicy(user.organizationId),
    ]);
    return { password, lockout, mfa };
  }

  @Put('security-policy/password')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('security.rbac.manage')
  setPasswordPolicy(@CurrentUser() user: AuthUser, @Body() dto: PasswordPolicyDto) {
    return this.settings.setPasswordPolicy(user.organizationId, user.userId, dto);
  }

  @Put('security-policy/lockout')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('security.rbac.manage')
  setLockoutPolicy(@CurrentUser() user: AuthUser, @Body() dto: LockoutPolicyDto) {
    return this.settings.setLockout(user.organizationId, user.userId, dto);
  }

  /* ---- Credential login ---- */
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @ReqContext() ctx: RequestContext) {
    return this.loginService.login(dto, toSessionContext(ctx), Date.now());
  }

  @Post('mfa/login')
  @HttpCode(200)
  mfaLogin(@Body() dto: MfaLoginDto, @ReqContext() ctx: RequestContext) {
    return this.loginService.completeMfa(dto, toSessionContext(ctx), Date.now());
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @ReqContext() ctx: RequestContext) {
    return this.tokens.rotate(dto.refreshToken, toSessionContext(ctx));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshDto) {
    await this.tokens.revoke(dto.refreshToken);
    return { success: true };
  }

  /* ---- SSO / LDAP ---- */
  @Get('sso/:provider/start')
  ssoStart(@Param('provider') provider: string, @Query('slug') slug: string) {
    return this.sso.start(slug, provider);
  }

  @Get('sso/callback')
  ssoCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.sso.callback(code, state, toSessionContext(ctx));
  }

  @Post('ldap/login')
  @HttpCode(200)
  ldapLogin(@Body() dto: LdapLoginDto, @ReqContext() ctx: RequestContext) {
    return this.ldap.authenticate(dto.organizationSlug, dto.email, dto.password, toSessionContext(ctx));
  }

  /* ---- Authenticated self-service ---- */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return {
      id: user.userId,
      email: user.email,
      fullName: null,
      organizationId: user.organizationId,
      permissions: user.permissions,
      mustChangePassword: user.mustChangePassword,
      mustEnrollMfa: user.mustEnrollMfa,
    };
  }

  @Post('password/change')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.passwords.changePassword(user, dto.currentPassword, dto.newPassword);
    return { success: true };
  }

  /**
   * Forced "set a new password" screen after signing in with a temporary password.
   * Requires an authenticated session; the must-change guard restricts such a user
   * to this endpoint. Returns a fresh session so the client is no longer flagged.
   */
  @Post('password/set-initial')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async setInitialPassword(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Body() dto: SetInitialPasswordDto,
  ) {
    await this.passwords.setInitialPassword(user, dto.newPassword);
    return this.tokens.issueSession(
      { id: user.userId, organizationId: user.organizationId, email: user.email, fullName: null },
      toSessionContext(ctx),
    );
  }

  /** Self-service forgot-password: emails a reset link. Always succeeds (anti-enumeration). */
  @Post('password/forgot')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.passwords.requestReset(dto.organizationSlug, dto.email, process.env.PUBLIC_APP_URL ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173');
    return { success: true };
  }

  /** Complete a self-service reset using the token from the emailed link. */
  @Post('password/reset')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.passwords.resetWithToken(dto.token, dto.newPassword);
    return { success: true };
  }

  @Get('mfa/status')
  @UseGuards(JwtAuthGuard)
  async mfaStatus(@CurrentUser() user: AuthUser) {
    return { enabled: await this.mfa.isEnabled(user.userId) };
  }

  @Post('mfa/setup')
  @UseGuards(JwtAuthGuard)
  mfaSetup(@CurrentUser() user: AuthUser) {
    return this.mfa.setup(user);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async mfaEnable(@CurrentUser() user: AuthUser, @Body() dto: MfaEnableDto) {
    return { backupCodes: await this.mfa.enable(user, dto.code, Date.now()) };
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async mfaDisable(@CurrentUser() user: AuthUser) {
    await this.mfa.disable(user);
    return { success: true };
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  listSessions(@CurrentUser() user: AuthUser) {
    return this.sessions.listSessions(user);
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.sessions.revokeSession(user, id);
    return { id };
  }
}
