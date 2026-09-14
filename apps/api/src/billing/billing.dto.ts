import { IsIn, IsInt, IsOptional, IsString, Length, Min, MinLength } from 'class-validator';
import { PLAN_CODES } from '../license/plans';
import { BILLING_INTERVALS, PAYMENT_METHODS } from './billing.types';

/**
 * What a browser may say about a plan change: WHICH plan, and HOW OFTEN. Never how
 * much. The amount is looked up server-side from `plan_prices`, so there is no field
 * here — and therefore no request — in which a client can propose a price.
 */
export class CheckoutDto {
  @IsIn(PLAN_CODES as readonly string[]) planCode!: string;
  @IsIn(BILLING_INTERVALS as readonly string[]) interval!: string;
}

export class CancelDto {
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
}

/** Recording a payment is a platform-admin act; the amount is theirs to state. */
export class RecordPaymentDto {
  /** Minor units. Omitted means "the whole invoice". */
  @IsOptional() @IsInt() @Min(0) amountMinor?: number;
  @IsOptional() @IsIn(PAYMENT_METHODS as readonly string[]) method?: string;
  /** The bank transaction id or cheque number — what makes this checkable later. */
  @IsOptional() @IsString() @Length(0, 200) reference?: string;
  @IsOptional() @IsString() paidAt?: string;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
}

export class IssueInvoiceDto {
  @IsIn(PLAN_CODES as readonly string[]) planCode!: string;
  @IsIn(BILLING_INTERVALS as readonly string[]) interval!: string;
  @IsOptional() @IsString() @Length(0, 1000) notes?: string;
}

export class ComplimentaryDto {
  @IsIn(PLAN_CODES as readonly string[]) planCode!: string;
  @IsInt() @Min(1) days!: number;
  @IsString() @MinLength(3) reason!: string;
}

export class ExtendDto {
  @IsInt() @Min(1) days!: number;
  @IsString() @MinLength(3) reason!: string;
}

export class SetPriceDto {
  @IsIn(PLAN_CODES as readonly string[]) planCode!: string;
  @IsIn(BILLING_INTERVALS as readonly string[]) interval!: string;
  @IsInt() @Min(0) amountMinor!: number;
  @IsOptional() @IsString() @Length(0, 120) providerPriceId?: string;
}

export class VoidInvoiceDto {
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
}
