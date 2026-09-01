import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityMapService } from './identity-map.service';
import { SisModule } from '../sis/sis.module';

/**
 * External identity mapping module. Resolves external actors (SIS teachers today;
 * students/alumni/clients later) to 360 employees via an explicit, admin-maintained
 * table. Exported so the external-evaluation flow can resolve the target employee.
 */
@Module({
  imports: [SisModule],
  controllers: [IdentityController],
  providers: [IdentityMapService],
  exports: [IdentityMapService],
})
export class IdentityModule {}
