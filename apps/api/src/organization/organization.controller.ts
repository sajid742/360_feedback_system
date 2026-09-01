import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../common/auth/permissions.guard';
import { OrgWritableGuard } from '../common/auth/org-writable.guard';
import { RequirePermissions } from '../common/auth/require-permissions.decorator';
import { CurrentUser, ReqContext, type AuthUser, type RequestContext } from '../common/auth/current-user';
import { DepartmentService } from './services/department.service';
import { DesignationService } from './services/designation.service';
import { EmployeeService } from './services/employee.service';
import { CampusService } from './services/campus.service';
import { ORG_PERMISSIONS } from './organization.permissions';
import {
  AssignMatrixDto,
  CreateCampusDto,
  CreateDepartmentDto,
  CreateDesignationDto,
  CreateEmployeeDto,
  EmployeeQueryDto,
  UpdateCampusDto,
  UpdateDepartmentDto,
  UpdateDesignationDto,
  UpdateEmployeeDto,
} from './dto/organization.dto';

// OrgWritableGuard makes all mutations (POST/PUT/DELETE) read-only when the tenant
// is in External HR mode; GETs always pass, so existing Internal-mode behaviour is
// unchanged.
@Controller('organization')
@UseGuards(JwtAuthGuard, PermissionsGuard, OrgWritableGuard)
export class OrganizationController {
  constructor(
    private readonly departments: DepartmentService,
    private readonly designations: DesignationService,
    private readonly employees: EmployeeService,
    private readonly campuses: CampusService,
  ) {}

  /* Departments */
  @Get('departments/tree')
  @RequirePermissions(ORG_PERMISSIONS.read)
  deptTree(@CurrentUser() user: AuthUser) {
    return this.departments.tree(user);
  }

  @Post('departments')
  @RequirePermissions(ORG_PERMISSIONS.departmentManage)
  createDept(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateDepartmentDto) {
    return this.departments.create(user, ctx, dto);
  }

  @Put('departments/:id')
  @RequirePermissions(ORG_PERMISSIONS.departmentManage)
  updateDept(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departments.update(user, ctx, id, dto);
  }

  @Delete('departments/:id')
  @HttpCode(200)
  @RequirePermissions(ORG_PERMISSIONS.departmentManage)
  async removeDept(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.departments.remove(user, ctx, id);
    return { id };
  }

  /* Designations */
  @Get('designations')
  @RequirePermissions(ORG_PERMISSIONS.read)
  listDesignations(@CurrentUser() user: AuthUser) {
    return this.designations.list(user);
  }

  @Post('designations')
  @RequirePermissions(ORG_PERMISSIONS.designationManage)
  createDesignation(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateDesignationDto) {
    return this.designations.create(user, ctx, dto);
  }

  @Put('designations/:id')
  @RequirePermissions(ORG_PERMISSIONS.designationManage)
  updateDesignation(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDesignationDto,
  ) {
    return this.designations.update(user, ctx, id, dto);
  }

  @Delete('designations/:id')
  @HttpCode(200)
  @RequirePermissions(ORG_PERMISSIONS.designationManage)
  async removeDesignation(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.designations.remove(user, ctx, id);
    return { id };
  }

  /* Employees */
  @Get('employees')
  @RequirePermissions(ORG_PERMISSIONS.read)
  listEmployees(@CurrentUser() user: AuthUser, @Query() query: EmployeeQueryDto) {
    return this.employees.list(user, query);
  }

  @Post('employees')
  @RequirePermissions(ORG_PERMISSIONS.employeeManage)
  createEmployee(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateEmployeeDto) {
    return this.employees.create(user, ctx, dto);
  }

  @Put('employees/:id')
  @RequirePermissions(ORG_PERMISSIONS.employeeManage)
  updateEmployee(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employees.update(user, ctx, id, dto);
  }

  @Post('employees/:id/matrix')
  @HttpCode(200)
  @RequirePermissions(ORG_PERMISSIONS.employeeManage)
  async assignMatrix(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignMatrixDto,
  ) {
    await this.employees.assignMatrix(user, ctx, id, dto);
    return { id };
  }

  @Delete('employees/:id')
  @HttpCode(200)
  @RequirePermissions(ORG_PERMISSIONS.employeeManage)
  async terminate(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.employees.terminate(user, ctx, id);
    return { id };
  }

  @Get('org-chart')
  @RequirePermissions(ORG_PERMISSIONS.read)
  orgChart(@CurrentUser() user: AuthUser) {
    return this.employees.orgChart(user);
  }

  /* Campuses */
  @Get('campuses')
  @RequirePermissions(ORG_PERMISSIONS.read)
  listCampuses(@CurrentUser() user: AuthUser) {
    return this.campuses.list(user);
  }

  @Post('campuses')
  @RequirePermissions(ORG_PERMISSIONS.campusManage)
  createCampus(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Body() dto: CreateCampusDto) {
    return this.campuses.create(user, ctx, dto);
  }

  @Put('campuses/:id')
  @RequirePermissions(ORG_PERMISSIONS.campusManage)
  updateCampus(
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampusDto,
  ) {
    return this.campuses.update(user, ctx, id, dto);
  }

  @Delete('campuses/:id')
  @HttpCode(200)
  @RequirePermissions(ORG_PERMISSIONS.campusManage)
  async removeCampus(@CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.campuses.remove(user, ctx, id);
    return { id };
  }
}
