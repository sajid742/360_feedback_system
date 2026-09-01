import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

/**
 * Liveness/readiness endpoints (F18). Mounted at the ROOT (outside the /api/v1
 * prefix — see main.ts exclude list) so load balancers, orchestrators (k8s
 * livenessProbe/readinessProbe) and uptime monitors can reach `/health` and
 * `/ready` at conventional paths. Both are public.
 *
 * Responses bypass the global success envelope (raw `@Res().json`) so monitoring
 * tools get a stable, predictable shape and a correct HTTP status — 200 when
 * ready, 503 when a hard dependency (the database) is down.
 */
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  liveness(@Res() res: Response): void {
    res.status(200).json(this.health.liveness());
  }

  @Get('ready')
  async readiness(@Res() res: Response): Promise<void> {
    const result = await this.health.readiness();
    res.status(result.ready ? 200 : 503).json(result);
  }
}
