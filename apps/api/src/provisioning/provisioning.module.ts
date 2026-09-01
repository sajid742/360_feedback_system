import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';

/** In-app organisation provisioning / first-run setup (F22). */
@Module({
  imports: [PrismaModule],
  controllers: [ProvisioningController],
  providers: [ProvisioningService],
})
export class ProvisioningModule {}
