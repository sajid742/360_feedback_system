import { Module } from '@nestjs/common';
import { BulkGenerationController } from './bulk-generation.controller';
import { BulkGenerationService } from './services/bulk-generation.service';
import { PlanService } from './services/plan.service';
import { SisModule } from '../sis/sis.module';
import { AppraisalModule } from '../appraisal/appraisal.module';
import { ExternalEvaluationModule } from '../external-evaluation/external-evaluation.module';

/**
 * Bulk Feedback Cycle / Parent Feedback generation. Composes existing modules —
 * AppraisalModule (cycle create/activate), ExternalEvaluationModule (parent links),
 * SisModule (parent/student data) — over the existing employee hierarchy. Adds no
 * parallel structures; the only new persistence is the BulkGenerationRun audit table.
 */
@Module({
  imports: [SisModule, AppraisalModule, ExternalEvaluationModule],
  controllers: [BulkGenerationController],
  providers: [BulkGenerationService, PlanService],
})
export class BulkGenerationModule {}
