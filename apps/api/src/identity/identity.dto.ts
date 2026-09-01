import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/** Known external actor types. New types (student, alumni, client, …) can be
 *  added here without any other schema change — the mapping mechanism is generic. */
export const EXTERNAL_TYPES = ['teacher', 'student', 'alumni', 'client', 'industry_supervisor'] as const;

export class UpsertIdentityMapDto {
  @IsIn(EXTERNAL_TYPES) externalType!: (typeof EXTERNAL_TYPES)[number];
  @IsString() @MinLength(1) externalId!: string;
  @IsOptional() @IsString() externalCode?: string;
  @IsOptional() @IsString() matchKey?: string;
  @IsUUID() employeeId!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
