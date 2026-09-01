import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ShortLinkService } from './services/short-link.service';

/**
 * Public short-link redirect. Mounted at /r/:code (excluded from the /api/v1
 * global prefix in main.ts). Counts the click, then 302s to the target.
 */
@Controller('r')
export class RedirectController {
  constructor(private readonly shortLinks: ShortLinkService) {}

  @Get(':code')
  async redirect(@Param('code') code: string, @Res() res: Response): Promise<void> {
    const target = await this.shortLinks.resolve(code);
    res.redirect(302, target);
  }
}
