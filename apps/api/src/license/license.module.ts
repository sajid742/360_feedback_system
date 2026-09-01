import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { AuditModule } from '../common/audit/audit.module';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';
import { LicensedFeatureGuard } from './licensed-feature.guard';

/**
 * Global so any module can inject LicenseService (and apply LicensedFeatureGuard)
 * without adding an import line to every feature module — licensing is cross-cutting
 * in the same way Prisma is.
 */
@Global()
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [LicenseController],
  providers: [LicenseService, LicensedFeatureGuard],
  exports: [LicenseService, LicensedFeatureGuard],
})
export class LicenseModule {}
