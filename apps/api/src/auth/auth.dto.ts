import { IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(1, 120)
  organizationSlug!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsString()
  captchaToken?: string;
}

export class MfaLoginDto {
  @IsString()
  mfaToken!: string;

  @IsString()
  @Length(4, 20)
  code!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(1)
  newPassword!: string;
}

export class MfaEnableDto {
  @IsString()
  @Length(4, 10)
  code!: string;
}

export class ForgotPasswordDto {
  @IsString()
  @Length(1, 120)
  organizationSlug!: string;

  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(10, 500)
  token!: string;

  @IsString()
  @MinLength(1)
  newPassword!: string;
}

export class SetInitialPasswordDto {
  @IsString()
  @MinLength(1)
  newPassword!: string;
}

export class LdapLoginDto {
  @IsString()
  @Length(1, 120)
  organizationSlug!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
