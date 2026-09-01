import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ReqContext, type RequestContext } from '../common/auth/current-user';
import { EvaluationLinkService } from './services/evaluation-link.service';
import { SubmitConsolidatedDto, SubmitEvaluationDto } from './external-evaluation.dto';

/**
 * PUBLIC, unauthenticated endpoints for parent/external evaluation. A hashed,
 * expiring, (optionally) one-time token in the URL is the only credential.
 * Mounted under the API prefix (/api/v1/public/evaluate) but carries no guards.
 * IP + user-agent are captured for the append-only feedback audit trail.
 */
@Controller('public/evaluate')
export class PublicEvaluationController {
  constructor(private readonly links: EvaluationLinkService) {}

  @Get(':token')
  validate(@Param('token') token: string, @ReqContext() ctx: RequestContext) {
    return this.links.validate(token, ctx);
  }

  @Post(':token')
  @HttpCode(200)
  submit(@Param('token') token: string, @ReqContext() ctx: RequestContext, @Body() dto: SubmitEvaluationDto) {
    return this.links.submit(token, dto, ctx);
  }

  /**
   * Consolidated form: one submission carrying a rating for each of the student's
   * teachers. Kept as its own route rather than overloading the body of the one above,
   * so the per-teacher form's contract is untouched.
   */
  @Post(':token/consolidated')
  @HttpCode(200)
  submitConsolidated(@Param('token') token: string, @ReqContext() ctx: RequestContext, @Body() dto: SubmitConsolidatedDto) {
    return this.links.submitConsolidated(token, dto, ctx);
  }
}
