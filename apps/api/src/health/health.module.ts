import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** Health/readiness module (F18). PrismaService comes from the global PrismaModule. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
