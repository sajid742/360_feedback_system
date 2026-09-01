import { Controller, Get, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SisService } from './sis.service';
import { AcademicController } from './academic.controller';
import { DirectoryController } from './directory.controller';
import { TeachingController } from './teaching.controller';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';

/** Public, unauthenticated readiness probe. */
@Controller('health')
class HealthController {
  @Get()
  health() {
    return { service: 'mock-sis', status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, AcademicController, DirectoryController, TeachingController, AdminController],
  providers: [PrismaService, SisService, AdminService],
})
export class AppModule {}
