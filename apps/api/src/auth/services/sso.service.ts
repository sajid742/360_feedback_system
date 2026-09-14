import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthSettingsService, type SsoProvider } from '../auth.settings';
import { TokenService, type IssuedTokens, type SessionContext } from './token.service';

interface SsoState {
  organizationId: string;
  providerId: string;
  purpose: 'sso';
}

/**
 * OIDC / generic OAuth2 authorization-code login. Stateless: the CSRF/state is a
 * short-lived signed JWT, so no server session store is needed (multi-instance
 * safe). Identity is resolved from the provider userinfo endpoint; users are NOT
 * auto-provisioned — a matching local user must already exist.
 */
@Injectable()
export class SsoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly settings: AuthSettingsService,
    private readonly tokens: TokenService,
  ) {}

  async start(orgSlug: string, providerId: string): Promise<{ url: string }> {
    /*
     * Root organisations only. A campus is an `organizations` row too, and campus slugs
     * share the global namespace, so without this filter a campus slug was accepted as
     * a sign-in realm.
     *
     * Both failures — unknown organisation and unconfigured provider — return the SAME
     * message. This endpoint is unauthenticated and unthrottled, so distinguishing them
     * let anyone enumerate which tenants exist on the platform.
     */
    const org = await this.prisma.organization.findFirst({
      where: { slug: orgSlug, orgType: 'root', deletedAt: null },
      select: { id: true },
    });
    if (!org) throw new UnauthorizedException('Single sign-on is not available for this organization.');
    const provider = await this.requireProvider(org.id, providerId).catch(() => {
      throw new UnauthorizedException('Single sign-on is not available for this organization.');
    });
    const state = await this.jwt.signAsync(
      { organizationId: org.id, providerId, purpose: 'sso' } satisfies SsoState,
      { expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri,
      scope: provider.scopes,
      state,
    });
    return { url: `${provider.authorizationUrl}?${params.toString()}` };
  }

  async callback(code: string, state: string, ctx: SessionContext): Promise<IssuedTokens> {
    const decoded = await this.verifyState(state);
    const provider = await this.requireProvider(decoded.organizationId, decoded.providerId);
    const accessToken = await this.exchangeCode(provider, code);
    const email = await this.fetchEmail(provider, accessToken);

    const user = await this.prisma.user.findFirst({
      where: { organizationId: decoded.organizationId, email: email.toLowerCase(), deletedAt: null, status: 'active' },
      select: { id: true, organizationId: true, email: true, fullName: true },
    });
    if (!user) throw new UnauthorizedException('No matching user for this identity.');
    return this.tokens.issueSession(user, ctx);
  }

  private async verifyState(state: string): Promise<SsoState> {
    try {
      const payload = await this.jwt.verifyAsync<SsoState>(state);
      if (payload.purpose !== 'sso') throw new Error('bad purpose');
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired SSO state.');
    }
  }

  private async exchangeCode(provider: SsoProvider, code: string): Promise<string> {
    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: provider.redirectUri,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
      }),
    });
    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) throw new UnauthorizedException('Token exchange failed.');
    return data.access_token;
  }

  private async fetchEmail(provider: SsoProvider, accessToken: string): Promise<string> {
    const response = await fetch(provider.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = (await response.json()) as Record<string, unknown>;
    const email = profile[provider.emailClaim];
    if (typeof email !== 'string') throw new UnauthorizedException('No email in identity profile.');
    return email;
  }

  private async requireProvider(orgId: string, providerId: string): Promise<SsoProvider> {
    const provider = await this.settings.ssoProvider(orgId, providerId);
    if (!provider) throw new UnauthorizedException('SSO provider not configured.');
    return provider;
  }
}
