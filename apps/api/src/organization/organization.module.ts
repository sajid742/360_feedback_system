import { Module } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { DepartmentService } from './services/department.service';
import { DesignationService } from './services/designation.service';
import { EmployeeService } from './services/employee.service';
import { CampusService } from './services/campus.service';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { OrgWritableGuard } from '../common/auth/org-writable.guard';

@Module({
  imports: [RbacModule, AuthModule],
  controllers: [OrganizationController],
  providers: [DepartmentService, DesignationService, EmployeeService, CampusService, OrgWritableGuard],
})
export class OrganizationModule {}
