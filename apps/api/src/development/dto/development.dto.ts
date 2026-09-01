import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

const STATUSES = ['open', 'in_progress', 'done'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;

export class CreateActionDto {
  @IsUUID() employeeId!: string;

  @IsString() @Length(1, 300) title!: string;

  @IsOptional() @IsString() @Length(1, 200) competency?: string;

  @IsOptional() @IsString() description?: string;

  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];

  @IsOptional() @IsDateString() dueDate?: string;
}

export class UpdateActionDto {
  @IsOptional() @IsString() @Length(1, 300) title?: string;

  @IsOptional() @IsString() @Length(1, 200) competency?: string;

  @IsOptional() @IsString() description?: string;

  @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];

  @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];

  @IsOptional() @IsDateString() dueDate?: string;
}
