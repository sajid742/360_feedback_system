import { IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { PLAN_CODES } from '../license/plans';
import { SUBSCRIPTION_STATUSES } from '../license/entitlements.types';

export class CreateTenantDto {
  @IsString() @MinLength(2) orgName!: string;
  @IsString() @MinLength(3) slug!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(10) password!: string;
  @IsOptional() @IsBoolean() withStarterContent?: boolean;
  /** The plan the new tenant starts on. Defaults to a Professional trial. */
  @IsOptional() @IsIn(PLAN_CODES as readonly string[]) planCode?: string;
  @IsOptional() @IsInt() @Min(0) @Max(365) trialDays?: number;
}

/**
 * Every field is optional: this is a patch, and a platform administrator changing a
 * plan must not have to restate the period dates to avoid clearing them.
 */
export class UpdateSubscriptionDto {
  @IsOptional() @IsIn(PLAN_CODES as readonly string[]) planCode?: string;
  @IsOptional() @IsIn(SUBSCRIPTION_STATUSES as readonly string[]) status?: string;
  @IsOptional() @IsISO8601() trialEndsAt?: string | null;
  @IsOptional() @IsISO8601() currentPeriodStart?: string | null;
  @IsOptional() @IsISO8601() currentPeriodEnd?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(180) graceDays?: number;
  /** Per-tenant deviations. Validated against the plan shape in the service. */
  @IsOptional() @IsObject() limitOverrides?: Record<string, unknown>;
  /** `{ add: [...], remove: [...] }` — module codes are validated in the service. */
  @IsOptional() @IsObject() moduleOverrides?: Record<string, unknown>;
  @IsOptional() @IsString() externalCustomerId?: string;
  @IsOptional() @IsString() externalSubscriptionId?: string;
  @IsOptional() @IsString() notes?: string;
}
