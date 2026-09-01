import { Module } from '@nestjs/common';
import { OrgImportModule } from '../org-import/org-import.module';
import { HrIntegrationController } from './hr-integration.controller';
import { HrConfigService } from './hr-config.service';
import { HrConnectionService } from './hr-connection.service';
import { HrSyncService } from './hr-sync.service';
import { HrProviderRegistry } from './hr-provider.registry';
import { MockHrProvider } from './providers/mock-hr.provider';
import { BambooHrProvider } from './providers/bamboohr.provider';
import { ZohoPeopleProvider } from './providers/zoho-people.provider';
import { GenericHrProvider } from './providers/generic-hr.provider';

/**
 * External HR Integration (optional). Reuses the Organization Import reconcile
 * engine (imported from OrgImportModule) to mirror an HR snapshot into the
 * existing internal model. First-wave real providers (BambooHR, Zoho People,
 * Generic REST/CSV/SFTP) plug into the same HrProvider contract via the registry;
 * per-tenant credentials live in HrConnectionService (encrypted at rest). Exports
 * HrConfigService so the read-only guard's owner module (and others) can reuse it.
 */
@Module({
  imports: [OrgImportModule],
  controllers: [HrIntegrationController],
  providers: [
    HrConfigService, HrConnectionService, HrSyncService, HrProviderRegistry,
    MockHrProvider, BambooHrProvider, ZohoPeopleProvider, GenericHrProvider,
  ],
  exports: [HrConfigService],
})
export class HrIntegrationModule {}
