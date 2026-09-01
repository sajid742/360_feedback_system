import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

const TYPES = ['institutional', 'departmental'] as const;
const FREQS = ['daily', 'weekly', 'monthly'] as const;

export class CreateScheduleDto {
  @IsString() @Length(1, 200) name!: string;

  @IsIn(TYPES) reportType!: (typeof TYPES)[number];

  @IsIn(FREQS) frequency!: (typeof FREQS)[number];

  @IsArray() @ArrayMinSize(1) @IsString({ each: true })
  recipients!: string[];

  @IsOptional() @IsUUID() cycleId?: string;
}
