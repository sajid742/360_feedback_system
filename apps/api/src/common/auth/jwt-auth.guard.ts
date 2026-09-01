import { AuthGuard } from '@nestjs/passport';

/**
 * Validates the JWT bearer token and populates `request.user` with AuthUser.
 * Provided by the Authentication module; included for standalone compile.
 */
export class JwtAuthGuard extends AuthGuard('jwt') {}
