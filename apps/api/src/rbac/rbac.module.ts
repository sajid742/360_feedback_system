import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { ScopeService } from './scope.service';

/**
 * RBAC: user/role administration + the shared ScopeService used for record-level
 * data restriction. ScopeService is exported so feature modules (organization,
 * reports) can enforce the reporting/own data scope. Reuses the existing
 * permission catalog, roles and audit — no parallel structures.
 */
@Module({
  imports: [AuthModule],
  controllers: [RbacController],
  providers: [RbacService, ScopeService],
  exports: [ScopeService],
})
export class RbacModule {}
