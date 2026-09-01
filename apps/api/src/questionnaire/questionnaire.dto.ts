import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

const TYPES = ['rating', 'yes_no', 'multiple_choice', 'text', 'numeric'] as const;
type QuestionType = (typeof TYPES)[number];

export class QuestionQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(TYPES) type?: QuestionType;
  @IsOptional() @IsUUID() competencyId?: string;
  @IsOptional() @IsString() category?: string;
}

export class CreateQuestionDto {
  @IsString() @MinLength(1) text!: string;
  @IsIn(TYPES) type!: QuestionType;
  @IsOptional() @IsUUID() competencyId?: string;
  @IsOptional() @IsUUID() ratingScaleId?: string;
  @IsOptional() @IsString() @Length(1, 120) category?: string;
  @IsOptional() @IsBoolean() isMandatory?: boolean;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsArray() options?: string[];
}

export class UpdateQuestionDto {
  @IsOptional() @IsString() @MinLength(1) text?: string;
  @IsOptional() @IsIn(TYPES) type?: QuestionType;
  @IsOptional() @IsUUID() competencyId?: string | null;
  @IsOptional() @IsUUID() ratingScaleId?: string | null;
  @IsOptional() @IsString() @Length(1, 120) category?: string;
  @IsOptional() @IsBoolean() isMandatory?: boolean;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsArray() options?: string[];
  @IsOptional() @IsIn(['active', 'archived']) status?: string;
}

export class CreateTemplateDto {
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsString() description?: string;
}

export class AddSectionDto {
  @IsString() @Length(1, 200) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class AddSectionQuestionDto {
  @IsUUID() questionId!: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsNumber() weightOverride?: number;
  @IsOptional() @IsBoolean() isMandatoryOverride?: boolean;
  @IsOptional() @IsObject() condition?: Record<string, unknown>;
}

export class CreateRubricDto {
  @IsString() @Length(1, 200) title!: string;
  @IsOptional() @IsUUID() competencyId?: string;
  @IsOptional() @IsUUID() ratingScaleId?: string;
  @IsObject() descriptors!: Record<string, unknown>;
}
