import { Module } from '@nestjs/common';
import { ExternalEvaluationController } from './external-evaluation.controller';
import { PublicEvaluationController } from './public-evaluation.controller';
import { EvaluationLinkService } from './services/evaluation-link.service';
import { SisModule } from '../sis/sis.module';
import { CommunicationModule } from '../communication/communication.module';
import { IdentityModule } from '../identity/identity.module';
import { AppraisalModule } from '../appraisal/appraisal.module';

/**
 * External evaluation (SIS Phase 2): tokenised, no-login parent evaluation links.
 * Resolves the SIS teacher to a 360 employee (IdentityModule), records feedback
 * into that employee's active cycle as a "Parents" source, and scores it via the
 * standard ScoringService (AppraisalModule). Delivery goes through the
 * Communication gateway; SIS supplies the student/teacher/subject context.
 */
@Module({
  imports: [SisModule, CommunicationModule, IdentityModule, AppraisalModule],
  controllers: [ExternalEvaluationController, PublicEvaluationController],
  providers: [EvaluationLinkService],
  exports: [EvaluationLinkService],
})
export class ExternalEvaluationModule {}
