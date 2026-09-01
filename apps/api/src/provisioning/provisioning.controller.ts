import { Body, Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { ProvisioningService } from './provisioning.service';

class CreateOrganizationDto {
  @IsString() @Length(2, 200) orgName!: string;
  @IsString() @Length(3, 120) slug!: string;
  @IsEmail() email!: string;
  @IsString() @Length(10, 200) password!: string;
  @IsOptional() @IsBoolean() withStarterContent?: boolean;
}

/**
 * Organisation provisioning (F22) — the in-app replacement for running the
 * bootstrap CLI on the server.
 *
 * Intentionally OUTSIDE the JWT/RBAC guards: creating a tenant is a platform
 * operation, not something any organisation's users should be able to do. See
 * `ProvisioningService` for the two gates (open first run, platform key after).
 */
@Controller('provisioning')
export class ProvisioningController {
  constructor(private readonly provisioning: ProvisioningService) {}

  /** Whether this installation still needs setup, and whether provisioning is possible. */
  @Get('status')
  status() {
    return this.provisioning.status();
  }

  @Post('organizations')
  @HttpCode(201)
  create(@Body() dto: CreateOrganizationDto, @Headers('x-provisioning-key') key?: string) {
    return this.provisioning.create(dto, key);
  }
}
