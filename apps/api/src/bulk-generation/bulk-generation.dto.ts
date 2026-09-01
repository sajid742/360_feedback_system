import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, ValidateNested } from 'class-validator';

export class EvaluatorsDto {
  @IsOptional() @IsBoolean() self?: boolean;
  @IsOptional() @IsBoolean() manager?: boolean;
  @IsOptional() @IsBoolean() peer?: boolean;
  @IsOptional() @IsBoolean() subordinate?: boolean;
  @IsOptional() @IsBoolean() parent?: boolean;
}

export class PeerDto {
  @IsOptional() @IsInt() @Min(0) min?: number;
  @IsOptional() @IsInt() @Min(1) max?: number;
  @IsOptional() @IsBoolean() crossDepartment?: boolean;
}

export class BulkConfigDto {
  @IsOptional() @ValidateNested() @Type(() => EvaluatorsDto) evaluators?: EvaluatorsDto;
  /** Rungs of the reporting line to ask. 1 = the immediate line manager only (default). */
  @IsOptional() @IsInt() @Min(1) @Max(6) managerLevels?: number;
  @IsOptional() @ValidateNested() @Type(() => PeerDto) peer?: PeerDto;
  @IsOptional() @IsBoolean() allowOutOfScope?: boolean;
  @IsOptional() @IsBoolean() includeParents?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) channels?: string[];
  @IsOptional() @IsBoolean() notify?: boolean;
}

export class PreviewDto {
  @IsIn(['all', 'campus', 'department']) scopeType!: 'all' | 'campus' | 'department';
  @IsOptional() @IsString() scopeId?: string;
  @IsOptional() @ValidateNested() @Type(() => BulkConfigDto) config?: BulkConfigDto;
}

export class CycleDto {
  @IsString() name!: string;
  @IsString() startDate!: string;
  @IsString() endDate!: string;
  @IsOptional() @IsString() submissionDeadline?: string;
  @IsOptional() @IsString() templateId?: string;
  @IsOptional() @IsString() ratingScaleId?: string;
}

/**
 * Optional questionnaire per evaluator type. Any code omitted inherits the cycle
 * questionnaire, which is the behaviour bulk generation has always had.
 */
export class QuadrantTemplatesDto {
  @IsOptional() @IsUUID() self?: string;
  @IsOptional() @IsUUID() manager?: string;
  @IsOptional() @IsUUID() peer?: string;
  @IsOptional() @IsUUID() subordinate?: string;
  @IsOptional() @IsUUID() parent?: string;
}

export class GenerateDto extends PreviewDto {
  @ValidateNested() @Type(() => CycleDto) cycle!: CycleDto;
  @IsOptional() @ValidateNested() @Type(() => QuadrantTemplatesDto) quadrantTemplates?: QuadrantTemplatesDto;
}
