import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiProviderController } from './ai-provider.controller';
import { InsightsService } from './services/insights.service';
import { AiProviderService } from './services/ai-provider.service';
import { RbacModule } from '../rbac/rbac.module';
import { ReportsModule } from '../reports/reports.module';
import { ConfigModule } from '../config/config.module';
import { AuditModule } from '../common/audit/audit.module';
import { AiEnabledGuard } from './ai-enabled.guard';

/**
 * RbacModule (ScopeService) and ReportsModule (ReportsService) are imported so
 * per-employee AI insights enforce exactly the same data-scope and results-release
 * rules as the equivalent individual report (F-C8).
 *
 * `AiProviderController` is a second controller rather than more routes on the first,
 * because the two are gated differently: viewing insights is `ai.read`, configuring a
 * provider is `configuration.manage`. AuditModule is imported so a provider change is
 * recorded — without the key.
 */
@Module({
  imports: [RbacModule, ReportsModule, ConfigModule, AuditModule],
  controllers: [AiController, AiProviderController],
  providers: [InsightsService, AiProviderService, AiEnabledGuard],
})
export class AiModule {}
