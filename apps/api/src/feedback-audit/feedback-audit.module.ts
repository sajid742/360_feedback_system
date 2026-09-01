import { Global, Module } from '@nestjs/common';
import { FeedbackAuditService } from './feedback-audit.service';
import { FeedbackAuditController } from './feedback-audit.controller';

/**
 * 360 Feedback Audit Trail. Global so the write-side (`FeedbackAuditService`) can
 * be injected by any lifecycle service without per-module import wiring, mirroring
 * the existing generic `AuditModule`. The read-side controller is admin-only.
 */
@Global()
@Module({
  controllers: [FeedbackAuditController],
  providers: [FeedbackAuditService],
  exports: [FeedbackAuditService],
})
export class FeedbackAuditModule {}
