import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Errors } from '../errors/app-error';
import { IS_PUBLIC } from '../decorators/auth.decorators';
import { TokenService } from '../../modules/auth/token.service';
import { RbacService } from '../../modules/rbac/rbac.service';
import { PrismaService } from '../../prisma/prisma.service';
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
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw Errors.unauthenticated();

    const claims = await this.tokens.verifyAccessToken(header.slice(7).trim());
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      include: { user: true },
    });
    const now = new Date();
    if (
      !session ||
      session.userId !== claims.sub ||
      session.organizationId !== claims.org ||
      session.revokedAt ||
      session.expiresAt <= now ||
      !session.user.isActive ||
      session.user.deletedAt
    ) {
      throw Errors.unauthenticated('SESSION_INVALID', 'Session is no longer valid; please sign in again');
    }

    req.user = {
      userId: session.userId,
      organizationId: session.organizationId,
      sessionId: session.id,
      email: session.user.email,
      fullName: session.user.fullName,
      permissions: await this.rbac.loadPermissionSet(session.userId, session.organizationId),
    };
    return true;
  }
}
