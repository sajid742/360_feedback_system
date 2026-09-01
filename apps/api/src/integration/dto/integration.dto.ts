import { ArrayMaxSize, IsArray, IsBoolean, IsISO8601, IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  scopes?: string[];

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class CreateWebhookDto {
  @IsUrl({ require_tld: false })
  @Length(1, 2048)
  url!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  events?: string[];

  @IsOptional()
  @IsString()
  @Length(0, 200)
  description?: string;
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsUrl({ require_tld: false })
  @Length(1, 2048)
  url?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  events?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  description?: string;
}
