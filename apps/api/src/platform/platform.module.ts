import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AuditModule } from '../common/audit/audit.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * Platform administration. Imports no feature module, because it has no business
 * reading a tenant's data — only the organisations table and their subscriptions.
 * `EntitlementService` arrives through the global LicenseModule.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformAdminGuard],
  exports: [PlatformService],
})
export class PlatformModule {}
