import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min, MinLength } from 'class-validator';

const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
const EVENTS = ['cycle_started', 'feedback_reminder', 'final_reminder', 'feedback_submitted', 'cycle_closed', 'admin_message'] as const;

export class SendMessageDto {
  @IsIn(CHANNELS) channel!: 'email' | 'sms' | 'whatsapp';
  @IsString() @MinLength(1) recipient!: string;
  @IsOptional() @IsString() subject?: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsString() templateKey?: string;
}

export class OtpRequestDto {
  @IsString() @MinLength(1) identifier!: string;
  @IsIn(CHANNELS) channel!: 'email' | 'sms' | 'whatsapp';
  @IsString() @Length(1, 60) purpose!: string;
}

export class OtpVerifyDto {
  @IsString() @MinLength(1) identifier!: string;
  @IsString() @Length(1, 60) purpose!: string;
  @IsString() @Length(4, 10) code!: string;
}

export class CreateCampaignDto {
  @IsString() @Length(1, 200) name!: string;
  @IsIn(CHANNELS) channel!: 'email' | 'sms' | 'whatsapp';
  @IsOptional() @IsString() subject?: string;
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsString() templateKey?: string;
  @IsObject() audience!: Record<string, unknown>;
}

export class CreateShortLinkDto {
  @IsString() @MinLength(1) targetUrl!: string;
}

export class WebhookDto {
  @IsString() providerMessageId!: string;
  @IsString() status!: string;
}

export class UpsertTemplateDto {
  @IsIn(EVENTS) event!: (typeof EVENTS)[number];
  @IsIn(CHANNELS) channel!: 'email' | 'sms' | 'whatsapp';
  @IsString() @Length(0, 255) subject!: string;
  @IsString() @Length(1, 5000) body!: string;
  @IsBoolean() isActive!: boolean;
}

export class ResetTemplateDto {
  @IsIn(EVENTS) event!: (typeof EVENTS)[number];
  @IsIn(CHANNELS) channel!: 'email' | 'sms' | 'whatsapp';
}

export class EmailSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsBoolean() secure?: boolean;
  @IsOptional() @IsBoolean() auth?: boolean;
  @IsOptional() @IsString() user?: string;
  @IsOptional() @IsString() pass?: string;
  @IsOptional() @IsString() senderName?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsInt() @Min(0) @Max(120000) connectionTimeout?: number;
  /** Explicit opt-out of TLS certificate verification — see EmailConfig for why it exists. */
  @IsOptional() @IsBoolean() allowUntrustedCertificate?: boolean;
}

export class SmsSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['twilio', 'generic']) provider?: 'twilio' | 'generic';
  @IsOptional() @IsString() senderId?: string;
  // Twilio
  @IsOptional() @IsString() accountSid?: string;
  @IsOptional() @IsString() authToken?: string;
  // Generic HTTP gateway
  @IsOptional() @IsString() endpoint?: string;
  @IsOptional() @IsIn(['POST', 'GET']) httpMethod?: 'POST' | 'GET';
  @IsOptional() @IsIn(['json', 'form']) bodyFormat?: 'json' | 'form';
  @IsOptional() @IsIn(['none', 'apikey', 'basic', 'bearer', 'oauth2']) authType?: 'none' | 'apikey' | 'basic' | 'bearer' | 'oauth2';
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() apiKeyHeader?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() oauthTokenUrl?: string;
  @IsOptional() @IsString() oauthClientId?: string;
  @IsOptional() @IsString() oauthClientSecret?: string;
  @IsOptional() @IsString() toParam?: string;
  @IsOptional() @IsString() messageParam?: string;
  @IsOptional() @IsString() fromParam?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) retryMaxAttempts?: number;
  @IsOptional() @IsInt() @Min(0) @Max(60000) retryBackoffMs?: number;
}

export class WhatsappSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['meta', 'twilio', 'waha', 'mock']) provider?: 'meta' | 'twilio' | 'waha' | 'mock';
  @IsOptional() @IsString() baseUrl?: string;
  @IsOptional() @IsString() phoneNumberId?: string;
  @IsOptional() @IsString() accessToken?: string;
  @IsOptional() @IsString() accountSid?: string;
  @IsOptional() @IsString() authToken?: string;
  @IsOptional() @IsString() session?: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() businessNumber?: string;
  @IsOptional() @IsString() webhookUrl?: string;
  @IsOptional() @IsString() webhookSecret?: string;
  @IsOptional() @IsBoolean() mock?: boolean;
}

export class GeneralSettingsDto {
  @IsOptional() @IsString() publicBaseUrl?: string;
  /** Explicit per-organisation override; blank means inherit from PUBLIC_APP_URL. */
  @IsOptional() @IsString() publicBaseUrlConfigured?: string;
  @IsOptional() @IsString() webhookSecret?: string;
}

export class ProviderSettingsDto {
  @IsOptional() @IsObject() email?: EmailSettingsDto;
  @IsOptional() @IsObject() sms?: SmsSettingsDto;
  @IsOptional() @IsObject() whatsapp?: WhatsappSettingsDto;
  @IsOptional() @IsObject() general?: GeneralSettingsDto;
}

export class BrandingDto {
  @IsString() @Length(1, 200) organizationName!: string;
  /**
   * A URL, or a `data:` URI for a small inline logo. The 200 KB ceiling is what lets an
   * administrator upload a logo with no object storage, upload endpoint or volume behind
   * it — the image rides in the existing JSONB record. Big enough for any sane PNG/SVG
   * mark, small enough not to bloat every branding read.
   */
  @IsString() @Length(0, 200_000) logoUrl!: string;
  @IsString() @Length(0, 20) primaryColor!: string;
  @IsString() @Length(0, 200) supportEmail!: string;
  @IsString() @Length(0, 500) footer!: string;

  @IsOptional() @IsString() @Length(0, 120) appName?: string;
  @IsOptional() @IsString() @Length(0, 12) shortName?: string;
  @IsOptional() @IsString() @Length(0, 200) legalName?: string;
  @IsOptional() @IsString() @Length(0, 200) tagline?: string;
  @IsOptional() @IsString() @Length(0, 200) website?: string;
  @IsOptional() @IsString() @Length(0, 60) supportPhone?: string;
  @IsOptional() @IsString() @Length(0, 200_000) faviconUrl?: string;
  @IsOptional() @IsString() @Length(0, 20) accentColor?: string;
  @IsOptional() @IsIn(['sharp', 'default', 'soft']) cornerStyle?: 'sharp' | 'default' | 'soft';
  @IsOptional() @IsString() @Length(0, 120) welcomeTitle?: string;
  @IsOptional() @IsString() @Length(0, 240) welcomeSubtitle?: string;
  @IsOptional() @IsString() @Length(0, 300) signInFooter?: string;
}

export class DefaultsDto {
  @IsObject() value!: { channels: ('email' | 'sms' | 'whatsapp')[] };
}

export class TestSendDto {
  @IsIn(CHANNELS) channel!: 'email' | 'sms' | 'whatsapp';
  @IsString() @MinLength(1) recipient!: string;
}
