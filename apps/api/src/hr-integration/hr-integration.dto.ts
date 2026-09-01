import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { OrgDataSource } from './hr-config.service';

export class UpdateHrConfigDto {
  @IsOptional() @IsIn(['internal', 'external_hr']) mode?: OrgDataSource;
  @IsOptional() @IsString() @MaxLength(60) provider?: string;
  @IsOptional() @IsBoolean() autoSync?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(720) intervalHours?: number;
  /** Mock-provider scenario for local testing ('full' | 'reduced'). */
  @IsOptional() @IsString() @MaxLength(20) mockScenario?: string;
}

export class SyncDto {
  /** true = live sync (writes); false/omitted = dry-run preview. */
  @IsOptional() @IsBoolean() live?: boolean;
}

export class UpdateHrConnectionDto {
  /** Provider key the settings belong to (bamboohr | zoho_people | generic). */
  @IsString() @MaxLength(60) provider!: string;
  /** Provider-specific connection fields; sanitized + secret-encrypted server-side. */
  @IsObject() settings!: Record<string, unknown>;
}
