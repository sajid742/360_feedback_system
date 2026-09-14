import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateCycleDto {
  @IsString() @Length(1, 200) name!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsOptional() @IsDateString() submissionDeadline?: string;
  @IsOptional() @IsUUID() templateId?: string;
  @IsOptional() @IsUUID() ratingScaleId?: string;
}

/**
 * Partial edit of an existing cycle — only the keys actually sent are applied.
 *
 * `submissionDeadline: null` is meaningful and allowed: it CLEARS the deadline,
 * leaving the cycle open until someone closes it by hand. class-validator's
 * `@IsOptional()` skips validation for `null` as well as `undefined`, which is what
 * makes "clear it" expressible at all — and the service distinguishes the two with
 * `'submissionDeadline' in dto`.
 */
export class UpdateCycleDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsDateString() submissionDeadline?: string | null;
  @IsOptional() @IsUUID() templateId?: string;
  @IsOptional() @IsUUID() ratingScaleId?: string;
}

export class AddSourceDto {
  @IsString() @Length(1, 40) code!: string;
  @IsString() @Length(1, 120) label!: string;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsInt() @Min(1) requiredCount?: number;
  @IsOptional() @IsBoolean() isAnonymous?: boolean;
  /** Optional quadrant-specific questionnaire; omit to inherit the cycle questionnaire. */
  @IsOptional() @IsUUID() templateId?: string;
}

/**
 * Change a quadrant after it exists. Until this DTO, `weight` could only be set at
 * creation — correcting it meant deleting the source, which is impossible once
 * assignments reference it. Every field is optional: an absent field is left alone.
 */
export class UpdateSourceDto {
  @IsOptional() @IsString() @Length(1, 120) label?: string;
  @IsOptional() @IsNumber() @Min(0) weight?: number;
  @IsOptional() @IsInt() @Min(1) requiredCount?: number;
  @IsOptional() @IsBoolean() isAnonymous?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SaveCycleTemplateDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 400) description?: string;
  @IsUUID() fromCycleId!: string;
}

export class ApplyCycleTemplateDto {
  @IsString() @Length(1, 200) name!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsOptional() @IsDateString() submissionDeadline?: string;
}

export class AddParticipantDto {
  @IsUUID() employeeId!: string;
}

export class ImportParticipantsDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true })
  emails!: string[];
}

export class CreateAssignmentDto {
  @IsUUID() participantId!: string;
  @IsUUID() sourceId!: string;
  @IsUUID() reviewerEmployeeId!: string;
  @IsOptional() @IsBoolean() propose?: boolean;
}

export class ResponseItemDto {
  @IsUUID() questionId!: string;
  @IsOptional() @IsNumber() ratingValue?: number;
  @IsOptional() @IsString() textValue?: string;
}

export class SubmitFeedbackDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ResponseItemDto)
  responses!: ResponseItemDto[];
}

export class CalibrateDto {
  @IsNumber() finalScore!: number;
  @IsOptional() @IsString() reason?: string;
}

export class SetPotentialDto {
  @IsNumber() potential!: number;
}

/** Organisation reminder settings (F6). */
export class ReminderSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(14) cadenceDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) sendHour?: number;
}

/** Set or clear a quadrant's own questionnaire. `null` restores the cycle questionnaire. */
export class SetSourceTemplateDto {
  @IsOptional() @IsUUID() templateId?: string | null;
}

/** Parents quadrant only: how it collects feedback. */
export class SetParentModeDto {
  /** 'consolidated' = one form per student. null/'standard' = one form per teacher. */
  @IsOptional() @IsIn(['standard', 'consolidated']) mode?: string | null;
  /** Refuse a submission that leaves a listed teacher unrated. Off by default. */
  @IsOptional() @IsBoolean() requireAll?: boolean;
}
