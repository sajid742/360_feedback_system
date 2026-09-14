import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ImportEntity, ImportMode } from './org-import.types';

const ENTITIES = ['organization', 'campuses', 'departments', 'designations', 'employees', 'competencies'];
const MODES = ['skip', 'update', 'replace', 'reset'];

export class UploadDto {
  @IsString() @MaxLength(255) filename!: string;
  /** Base64-encoded file bytes (data: URL prefix is tolerated). */
  @IsString() contentBase64!: string;
  @IsOptional() @IsIn(ENTITIES) entity?: ImportEntity; // required for CSV uploads
  @IsOptional() @IsIn(MODES) mode?: ImportMode;
  /**
   * Treat an employees file as the flat Staff sheet: derive the Departments,
   * Designations and Campuses it references instead of requiring them to exist. An
   * .xlsx with a sheet named "Staff" sets this on its own; a CSV has no sheet name,
   * so the caller says so.
   */
  @IsOptional() @IsBoolean() flat?: boolean;
}

export class ConfirmDto {
  @IsIn(MODES) mode!: ImportMode;
  @IsOptional() @IsBoolean() confirmDestructive?: boolean;
  @IsOptional() @IsString() @MaxLength(200) defaultPassword?: string;
}
