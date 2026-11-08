import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Errors } from '../errors/app-error';
import { IS_PUBLIC } from '../decorators/auth.decorators';
import { PrincipalService } from '../../modules/auth/principal.service';
import type { AuthedRequest } from '../../modules/auth/principal';

/**
 * Global guard: verifies the bearer access token and that its session is still live.
 * A revoked session (logout, password reset, deactivation, refresh-token reuse) stops
 * working immediately, not only when the access token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw Errors.unauthenticated();
    req.user = (await this.principals.fromAccessToken(header.slice(7).trim())).principal;
    return true;
  }
}
