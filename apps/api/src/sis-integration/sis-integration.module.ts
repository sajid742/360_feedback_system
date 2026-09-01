import { Module } from '@nestjs/common';
import { SisIntegrationController } from './sis-integration.controller';
import { SisMaintenanceController } from './sis-maintenance.controller';
import { SisMaintenanceService } from './sis-maintenance.service';
import { SisConfigService } from './sis-config.service';
import { SisConnectionService } from './sis-connection.service';
import { SisDatasetService } from './sis-dataset.service';
import { SisSyncService } from './sis-sync.service';
import { SisProviderRegistry } from './sis-provider.registry';
import { SisParseService } from './providers/sis-parse.service';
import { MockSisSnapshotProvider } from './providers/mock-sis-snapshot.provider';
import { GenericSisProvider } from './providers/generic-sis.provider';
import { OneRosterSisProvider } from './providers/oneroster-sis.provider';

/**
 * Student/SIS Integration. Per-tenant config + encrypted connection store, the
 * Excel/CSV import wizard, and Mock/Generic/OneRoster providers — all producing a
 * SisSnapshot persisted per organization (sis_datasets). Exports SisDatasetService so
 * the SIS module's tenant-aware provider can serve the roster through the existing
 * SisProvider interface. Additive; reuses Prisma/Audit (global) and the schedule.
 */
@Module({
  controllers: [SisIntegrationController, SisMaintenanceController],
  providers: [
    SisConfigService, SisConnectionService, SisDatasetService, SisProviderRegistry, SisParseService, SisSyncService, SisMaintenanceService,
    MockSisSnapshotProvider, GenericSisProvider, OneRosterSisProvider,
  ],
  exports: [SisDatasetService, SisMaintenanceService],
})
export class SisIntegrationModule {}
