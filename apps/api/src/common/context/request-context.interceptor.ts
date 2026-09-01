import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { requestContext } from './request-context';

/**
 * Enters the per-request AsyncLocalStorage store with the authenticated org id.
 * Runs after guards (so `req.user` is populated) and before the handler, using
 * `enterWith` so the store persists across the request's async chain. Purely
 * additive — it only makes the tenant available to context-aware singletons.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): ReturnType<CallHandler['handle']> {
    const req = context.switchToHttp().getRequest<{ user?: { organizationId?: string } }>();
    // Preserve the request id already placed in the store by the request-id
    // middleware (F19); only merge in the authenticated org id here.
    const store = requestContext.getStore();
    if (store) {
      store.organizationId = req?.user?.organizationId;
    } else {
      requestContext.enterWith({ organizationId: req?.user?.organizationId });
    }
    return next.handle();
  }
}
