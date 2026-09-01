import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Roster maintenance payloads. Every field is optional on the update DTOs
 * because the service applies a PATCH: a field that is absent is left as it was,
 * and only the fields actually present are recorded as local edits.
 */

export class SisStudentQueryDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(150) campus?: string;
  @IsOptional() @IsIn(['sis', 'manual']) origin?: 'sis' | 'manual';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(200) pageSize?: number;
}

class SisStudentFields {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(40) registrationNo?: string;
  @IsOptional() @IsString() @MaxLength(40) rollNo?: string;
  @IsOptional() @IsString() @MaxLength(20) gender?: string;
  @IsOptional() @IsIn(['active', 'inactive']) status?: string;
  @IsOptional() @IsString() @MaxLength(150) campus?: string;
  @IsOptional() @IsString() @MaxLength(120) currentClass?: string;
  @IsOptional() @IsString() @MaxLength(120) currentSection?: string;
  @IsOptional() @IsString() @MaxLength(150) program?: string;
  @IsOptional() @IsString() @MaxLength(150) faculty?: string;
  @IsOptional() @IsString() @MaxLength(150) department?: string;
  @IsOptional() @IsString() @MaxLength(120) session?: string;
  @IsOptional() @IsString() @MaxLength(120) semester?: string;
  @IsOptional() @IsString() @MaxLength(20) dateOfBirth?: string;
  @IsOptional() @IsString() @MaxLength(20) admissionDate?: string;
}

export class CreateSisStudentDto extends SisStudentFields {
  /** Optional; the service allocates an `M-S…` id when omitted, which can never
   *  collide with a provider's own numbering. */
  @IsOptional() @IsString() @MaxLength(64) id?: string;
}

export class UpdateSisStudentDto extends SisStudentFields {}

class SisParentFields {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(40) relationship?: string;
  @IsOptional() @IsString() @MaxLength(40) mobile?: string;
  @IsOptional() @IsString() @MaxLength(40) whatsapp?: string;
  @IsOptional() @IsString() @MaxLength(150) email?: string;
  @IsOptional() @IsString() @MaxLength(10) preferredLanguage?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateSisParentDto extends SisParentFields {
  @IsOptional() @IsString() @MaxLength(64) id?: string;
}

export class UpdateSisParentDto extends SisParentFields {}

export class SisEnrollmentDto {
  @IsString() @MaxLength(64) teachingAssignmentId!: string;
}
