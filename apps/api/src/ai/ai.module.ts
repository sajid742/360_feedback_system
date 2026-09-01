import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { InsightsService } from './services/insights.service';
import { AiProviderService } from './services/ai-provider.service';
import { RbacModule } from '../rbac/rbac.module';
import { ReportsModule } from '../reports/reports.module';
import { ConfigModule } from '../config/config.module';
import { AiEnabledGuard } from './ai-enabled.guard';

/**
 * RbacModule (ScopeService) and ReportsModule (ReportsService) are imported so
 * per-employee AI insights enforce exactly the same data-scope and results-release
 * rules as the equivalent individual report (F-C8).
 */
@Module({
  imports: [RbacModule, ReportsModule, ConfigModule],
  controllers: [AiController],
  providers: [InsightsService, AiProviderService, AiEnabledGuard],
})
export class AiModule {}
