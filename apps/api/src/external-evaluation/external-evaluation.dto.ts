import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CHANNELS = ['whatsapp', 'email', 'sms'] as const;

export class CreateEvaluationLinkDto {
  @IsString() @MinLength(1) studentId!: string;
  @IsString() @MinLength(1) teachingAssignmentId!: string;
  @IsOptional() @IsString() parentId?: string;
  /**
   * Target a specific cycle instead of the currently active one. Omitted, the service
   * picks the most recently started active cycle — the behaviour this endpoint always
   * had. The consolidated endpoint has accepted this since bulk generation was added;
   * the per-teacher endpoint had no way to say which cycle it meant.
   */
  @IsOptional() @IsUUID() cycleId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
  @IsOptional() @IsBoolean() oneTime?: boolean;
  @IsOptional() @IsUUID() templateId?: string;
  /** Send immediately after creation. */
  @IsOptional() @IsBoolean() send?: boolean;
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];
  /** Override recipient (else the selected parent's whatsapp/email is used). */
  @IsOptional() @IsString() recipient?: string;
}

export class SendEvaluationLinkDto {
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];
  @IsOptional() @IsString() recipient?: string;
  /**
   * Regenerate only. Re-issuing a link DISCARDS the responses, score and comment
   * already submitted against it and resets the linked reviewer assignments. On a
   * link the parent has already completed that destroys collected feedback, so it
   * is refused unless this is explicitly sent.
   */
  @IsOptional() @IsBoolean() force?: boolean;
}

export class EvaluationResponseItemDto {
  @IsString() @MinLength(1) questionId!: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) ratingValue?: number;
  @IsOptional() @IsString() textValue?: string;
}

export class SubmitEvaluationDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => EvaluationResponseItemDto)
  responses!: EvaluationResponseItemDto[];
}

/* ------------------------- consolidated parent form ------------------------ */

/**
 * One consolidated form covering every teacher of one student. The teacher list is
 * resolved from the SIS at generation and snapshotted, so the form cannot drift away
 * from the reviewer assignments created alongside it.
 */
export class CreateConsolidatedLinkDto {
  @IsString() @MinLength(1) studentId!: string;
  @IsOptional() @IsString() parentId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
  @IsOptional() @IsBoolean() oneTime?: boolean;
  @IsOptional() @IsBoolean() send?: boolean;
  @IsOptional() @IsIn(CHANNELS) channel?: (typeof CHANNELS)[number];
  @IsOptional() @IsString() recipient?: string;
  /** Target a specific cycle instead of the currently active one (bulk generation). */
  @IsOptional() @IsUUID() cycleId?: string;
}

/** One teacher's rating on the consolidated form. */
export class ConsolidatedRatingDto {
  @IsString() @MinLength(1) teacherId!: string;
  /**
   * Bounds are checked against the cycle's rating scale in the service, not here —
   * a tenant may configure a scale that is not 1-5.
   */
  @IsNumber() ratingValue!: number;
}

export class SubmitConsolidatedDto {
  /**
   * Only the teachers the parent actually rated. A teacher omitted here is treated as
   * "not asked": no response row, the assignment stays unsubmitted, and the teacher is
   * excluded from both the Parents average and the anonymity count.
   */
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConsolidatedRatingDto)
  ratings!: ConsolidatedRatingDto[];
}
