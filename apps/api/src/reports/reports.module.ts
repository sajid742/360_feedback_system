import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './services/reports.service';
import { ReportExportService } from './services/report-export.service';
import { DashboardLayoutService } from './services/dashboard-layout.service';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [RbacModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportExportService, DashboardLayoutService],
  exports: [ReportsService],
})
export class ReportsModule {}
