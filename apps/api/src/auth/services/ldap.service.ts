import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthSettingsService, type LdapConfig } from '../auth.settings';
import { TokenService, type IssuedTokens, type SessionContext } from './token.service';

/* Minimal structural types for ldapjs so this compiles without @types/ldapjs.
   `ldapjs` is a runtime dependency (see package.json). */
interface LdapEntry {
  objectName?: string;
  dn?: string;
}
interface LdapSearchEmitter {
  on(event: 'searchEntry', cb: (entry: { objectName?: string; pojo?: LdapEntry; dn?: string }) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'end', cb: () => void): void;
}
interface LdapClient {
  bind(dn: string, password: string, cb: (err: Error | null) => void): void;
  search(base: string, options: { filter: string; scope: string }, cb: (err: Error | null, res: LdapSearchEmitter) => void): void;
  unbind(): void;
}
interface LdapModule {
  createClient(options: { url: string }): LdapClient;
}

/**
 * LDAP / Active Directory login via search-then-bind: bind as the service
 * account, find the user's DN by email, then bind as that DN with the supplied
 * password. On success, issue a session for the matching local user.
 */
@Injectable()
export class LdapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AuthSettingsService,
    private readonly tokens: TokenService,
  ) {}

  async authenticate(
    orgSlug: string,
    email: string,
    password: string,
    ctx: SessionContext,
  ): Promise<IssuedTokens> {
    const org = await this.prisma.organization.findFirst({
      where: { slug: orgSlug, deletedAt: null },
      select: { id: true },
    });
    if (!org) throw new UnauthorizedException('Unknown organization.');
    const config = await this.settings.ldap(org.id);
    if (!config?.enabled) throw new ServiceUnavailableException('LDAP is not enabled.');

    const dn = await this.findUserDn(config, email);
    await this.bindAs(config, dn, password);

    const user = await this.prisma.user.findFirst({
      where: { organizationId: org.id, email: email.toLowerCase(), deletedAt: null, status: 'active' },
      select: { id: true, organizationId: true, email: true, fullName: true },
    });
    if (!user) throw new UnauthorizedException('No matching user for this directory account.');
    return this.tokens.issueSession(user, ctx);
  }

  private client(config: LdapConfig): LdapClient {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ldap = require('ldapjs') as LdapModule;
    return ldap.createClient({ url: config.url });
  }

  private findUserDn(config: LdapConfig, email: string): Promise<string> {
    const client = this.client(config);
    const filter = config.searchFilter.replace('{email}', email);
    return new Promise<string>((resolve, reject) => {
      client.bind(config.bindDn, config.bindPassword, (bindErr) => {
        if (bindErr) return reject(new UnauthorizedException('LDAP service bind failed.'));
        client.search(config.searchBase, { filter, scope: 'sub' }, (searchErr, res) => {
          if (searchErr) return reject(new UnauthorizedException('LDAP search failed.'));
          let dn: string | null = null;
          res.on('searchEntry', (entry) => {
            dn = entry.objectName ?? entry.pojo?.dn ?? entry.dn ?? null;
          });
          res.on('error', () => reject(new UnauthorizedException('LDAP search error.')));
          res.on('end', () => {
            client.unbind();
            dn ? resolve(dn) : reject(new UnauthorizedException('Directory account not found.'));
          });
        });
      });
    });
  }

  private bindAs(config: LdapConfig, dn: string, password: string): Promise<void> {
    const client = this.client(config);
    return new Promise<void>((resolve, reject) => {
      client.bind(dn, password, (err) => {
        client.unbind();
        err ? reject(new UnauthorizedException('Invalid directory credentials.')) : resolve();
      });
    });
  }
}
