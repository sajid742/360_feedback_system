import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CompetencyQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class CreateCompetencyDto {
  @IsUUID()
  categoryId!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateCompetencyDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
