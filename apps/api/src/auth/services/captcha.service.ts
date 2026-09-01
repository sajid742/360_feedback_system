import { Injectable, Logger } from '@nestjs/common';
import { AuthSettingsService } from '../auth.settings';

const VERIFY_URLS: Record<string, string> = {
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
  hcaptcha: 'https://hcaptcha.com/siteverify',
};

/** Verifies a captcha token against the org's configured provider. Returns true
 *  when captcha is not enabled (nothing to check). */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);

  constructor(private readonly settings: AuthSettingsService) {}

  async verify(organizationId: string, token: string | undefined): Promise<boolean> {
    const config = await this.settings.captcha(organizationId);
    if (!config?.enabled) return true;
    if (!token) return false;

    try {
      const response = await fetch(VERIFY_URLS[config.provider], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: config.secret, response: token }),
      });
      const data = (await response.json()) as { success?: boolean };
      return data.success === true;
    } catch (error) {
      this.logger.warn(`Captcha verification failed: ${(error as Error).message}`);
      return false;
    }
  }
}
