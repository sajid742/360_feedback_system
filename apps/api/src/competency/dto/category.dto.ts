import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CategoryQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCategoryDto {
  @IsString()
  @Length(1, 150)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  colorTone?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @Length(1, 150)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  colorTone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
