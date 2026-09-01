import { Module, type Provider } from '@nestjs/common';
import { SisController } from './sis.controller';
import { SIS_PROVIDER } from './sis-provider.interface';
import { MockSisProvider } from './providers/mock-sis.provider';
import { TenantSisProvider } from './providers/tenant-sis.provider';
import { SisIntegrationModule } from '../sis-integration/sis-integration.module';

/**
 * SIS integration module. `SIS_PROVIDER` is now bound to the TenantSisProvider, which
 * per request serves a tenant's imported/synced SIS dataset (via SisIntegrationModule's
 * SisDatasetService) and otherwise falls back to the legacy Mock SIS — so every SIS
 * consumer (browse, identity mapping, bulk generation, parent feedback) keeps working
 * unchanged. To add a real live SIS, implement SisSnapshotProvider in the integration
 * module; nothing here changes.
 */
const providerFactory: Provider = {
  provide: SIS_PROVIDER,
  useClass: TenantSisProvider,
};

@Module({
  imports: [SisIntegrationModule],
  controllers: [SisController],
  providers: [providerFactory, MockSisProvider, TenantSisProvider],
  exports: [SIS_PROVIDER],
})
export class SisModule {}
