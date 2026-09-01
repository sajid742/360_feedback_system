import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { CommunicationModule } from '../communication/communication.module';
import { ReportScheduleController } from './report-schedule.controller';
import { ReportScheduleService } from './report-schedule.service';

@Module({
  imports: [ReportsModule, CommunicationModule],
  controllers: [ReportScheduleController],
  providers: [ReportScheduleService],
})
export class ReportScheduleModule {}
