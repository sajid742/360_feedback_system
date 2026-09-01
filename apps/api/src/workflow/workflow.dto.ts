import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class WorkflowStepDto {
  @IsString() @Length(1, 200) name!: string;
  @IsInt() @Min(1) stepOrder!: number;
  @IsIn(['role', 'user']) assigneeType!: 'role' | 'user';
  @IsOptional() @IsUUID() assigneeValue?: string;
  @IsOptional() @IsInt() @Min(1) slaHours?: number;
}

export class CreateDefinitionDto {
  @IsString() @Length(1, 200) name!: string;
  @IsString() @Length(1, 80) entityType!: string;
  @IsIn(['sequential', 'parallel']) mode!: 'sequential' | 'parallel';
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => WorkflowStepDto)
  steps!: WorkflowStepDto[];
}

export class StartInstanceDto {
  @IsUUID() definitionId!: string;
  @IsString() @Length(1, 80) entityType!: string;
  @IsUUID() entityId!: string;
}

export class ActDto {
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @IsOptional() @IsString() comment?: string;
}

export class DelegateDto {
  @IsUUID() toUserId!: string;
}
