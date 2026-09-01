import { Module } from '@nestjs/common';
import { AppraisalController } from './appraisal.controller';
import { CycleService } from './services/cycle.service';
import { CycleTemplateService } from './services/cycle-template.service';
import { SetupService } from './services/setup.service';
import { AssignmentService } from './services/assignment.service';
import { ScoringService } from './services/scoring.service';
import { ReminderService } from './services/reminder.service';
import { IntegrationModule } from '../integration/integration.module';
import { CommunicationModule } from '../communication/communication.module';
import { UserNotificationModule } from '../user-notifications/user-notification.module';

@Module({
  imports: [IntegrationModule, CommunicationModule, UserNotificationModule],
  controllers: [AppraisalController],
  providers: [CycleService, CycleTemplateService, SetupService, AssignmentService, ScoringService, ReminderService],
  exports: [ScoringService, CycleService],
})
export class AppraisalModule {}
