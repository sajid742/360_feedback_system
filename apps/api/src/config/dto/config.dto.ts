import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

/* ---- Generic configuration key/value ---- */
export class SetConfigurationDto {
  @IsString()
  @Length(1, 60)
  module!: string;

  @IsString()
  @Length(1, 120)
  key!: string;

  // JSON value — any shape.
  value!: unknown;
}

/* ---- Feature flags ---- */
export class CreateFeatureFlagDto {
  @IsString()
  @Length(1, 120)
  key!: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateFeatureFlagDto {
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}

/* ---- Rating scales ---- */
export class RatingScaleLevelDto {
  @IsNumber()
  value!: number;

  @IsString()
  @Length(1, 60)
  label!: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}

export class CreateRatingScaleDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsIn(['5_point', '7_point', '10_point', 'percentage', 'letter_grade', 'custom'])
  scaleType!: string;

  @IsNumber()
  minValue!: number;

  @IsNumber()
  maxValue!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RatingScaleLevelDto)
  levels!: RatingScaleLevelDto[];
}

export class UpdateRatingScaleDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RatingScaleLevelDto)
  levels?: RatingScaleLevelDto[];
}
