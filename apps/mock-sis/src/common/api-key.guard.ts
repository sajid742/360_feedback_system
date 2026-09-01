import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * Vendor API-key guard. Every request must present the `X-API-Key` header
 * matching SIS_API_KEY — this simulates a real vendor credential the 360
 * system stores in its integration config.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const header = req.headers['x-api-key'];
    const presented = Array.isArray(header) ? header[0] : header;
    const expected = process.env.SIS_API_KEY ?? 'mock-sis-dev-key-change-me';
    if (!presented || presented !== expected) {
      throw new UnauthorizedException('Invalid or missing X-API-Key.');
    }
    return true;
  }
}
