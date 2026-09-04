import { IsBase64, IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateSisConfigDto {
  @IsOptional() @IsString() @MaxLength(60) provider?: string;
  @IsOptional() @IsBoolean() autoSync?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(720) intervalHours?: number;
  @IsOptional() @IsString() @MaxLength(20) mockScenario?: string;
}

export class UpdateSisConnectionDto {
  @IsString() @MaxLength(60) provider!: string;
  @IsObject() settings!: Record<string, unknown>;
}

export class SisSyncDto {
  /** true = live sync (writes); false/omitted = dry-run preview. */
  @IsOptional() @IsBoolean() live?: boolean;
  /**
   * Acknowledges a sync that would deactivate students/teachers or rename them.
   * A live sync WITHOUT this returns the dry-run preview instead of writing, so a
   * destructive run can never happen by accident. A harmless sync needs nothing.
   */
  @IsOptional() @IsBoolean() confirm?: boolean;
}

export class SisImportDto {
  @IsString() @MaxLength(260) filename!: string;
  @IsString() @IsBase64() base64!: string;
  /** For a CSV upload: which entity the file contains. */
  @IsOptional() @IsString() @MaxLength(40) entity?: string;
  /** true = validate/preview only (no writes). */
  @IsOptional() @IsBoolean() dryRun?: boolean;
  /**
   * Acknowledges an import that would deactivate or rename records, or re-point a
   * teacher to a different 360 employee. A live import WITHOUT this returns the
   * preview instead of writing — the same gate the provider sync uses.
   *
   * Before this existed the import path never sent a confirmation, so `apply()`
   * withheld every significant run forever: a workbook that dropped a leaver or
   * corrected a name could be previewed but never applied.
   */
  @IsOptional() @IsBoolean() confirm?: boolean;
}
