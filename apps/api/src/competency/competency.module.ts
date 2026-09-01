import { Module } from '@nestjs/common';
import { CategoryController } from './controllers/category.controller';
import { CompetencyController } from './controllers/competency.controller';
import { IndicatorController } from './controllers/indicator.controller';
import { CategoryService } from './services/category.service';
import { CompetencyService } from './services/competency.service';
import { VersionService } from './services/version.service';
import { IndicatorService } from './services/indicator.service';
import { StatsService } from './services/stats.service';
import { ProficiencyScaleService } from './services/proficiency-scale.service';

/**
 * Competency module (Phase 6). Depends on the global PrismaModule + AuditModule
 * (from the Configuration foundation) and the JWT strategy (from Authentication).
 */
@Module({
  controllers: [CategoryController, CompetencyController, IndicatorController],
  providers: [
    CategoryService,
    CompetencyService,
    VersionService,
    IndicatorService,
    StatsService,
    ProficiencyScaleService,
  ],
  exports: [CompetencyService],
})
export class CompetencyModule {}
