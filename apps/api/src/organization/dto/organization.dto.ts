import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  IsBoolean,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/* ---- Departments ---- */
export class CreateDepartmentDto {
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @IsString() @Length(1, 40) unitType?: string;
}
export class UpdateDepartmentDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsUUID() campusId?: string | null;
  @IsOptional() @IsString() @Length(1, 40) unitType?: string;
}

/* ---- Designations ---- */
export class CreateDesignationDto {
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsInt() @Min(0) level?: number;
  @IsOptional() @IsUUID() promotionToId?: string;
}
export class UpdateDesignationDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsInt() @Min(0) level?: number;
  @IsOptional() @IsUUID() promotionToId?: string | null;
}

/* ---- Employees ---- */
export class EmployeeQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() designationId?: string;
}
export class CreateEmployeeDto {
  @IsEmail() email!: string;
  @IsString() @Length(1, 200) fullName!: string;
  @IsString() @Length(1, 60) employeeCode!: string;
  @IsOptional() @IsString() @Length(8, 200) password?: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsUUID() designationId?: string;
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @IsUUID() lineManagerId?: string;
  @IsOptional() @IsDateString() joinDate?: string;
  /** Email a set-password invitation instead of handing over a temporary password (F28). */
  @IsOptional() @IsBoolean() sendInvite?: boolean;
}
export class UpdateEmployeeDto {
  @IsOptional() @IsUUID() departmentId?: string | null;
  @IsOptional() @IsUUID() designationId?: string | null;
  @IsOptional() @IsUUID() campusId?: string | null;
  @IsOptional() @IsUUID() lineManagerId?: string | null;
  @IsOptional() @IsIn(['active', 'on_leave']) status?: string;
}
export class AssignMatrixDto {
  @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) @Type(() => String)
  managerIds!: string[];
}

/* ---- Campuses ---- */
export class CreateCampusDto {
  @IsString() @Length(1, 200) name!: string;
  @IsString() @Length(1, 120) slug!: string;
}
export class UpdateCampusDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: string;
}
