import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';

export const INDICATOR_TYPES = ['positive', 'negative'] as const;
export type IndicatorType = (typeof INDICATOR_TYPES)[number];

export class CreateIndicatorDto {
  @IsIn(INDICATOR_TYPES)
  type!: IndicatorType;

  @IsString()
  @MinLength(1)
  text!: string;

  @IsOptional()
  @IsUUID()
  proficiencyLevelId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateIndicatorDto {
  @IsOptional()
  @IsIn(INDICATOR_TYPES)
  type?: IndicatorType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  text?: string;

  @IsOptional()
  @IsUUID()
  proficiencyLevelId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
