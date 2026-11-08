import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import type { AuthPrincipal } from './principal';
import { TokenService } from './token.service';

/**
 * Turns an access token into the caller's principal: verifies the token and that its session is
 * still live (a revoked session stops working immediately, not only when the token expires).
 * Used by the HTTP guard and the WebSocket gateway, so both apply the same rules.
 */
@Injectable()
export class PrincipalService {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async fromAccessToken(token: string): Promise<{ principal: AuthPrincipal; expiresAt: Date }> {
    const claims = await this.tokens.verifyAccessToken(token);
    const session = await this.prisma.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
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
    const tokenExpiry = claims.exp ? new Date(claims.exp * 1000) : session.expiresAt;
    return {
      principal: {
        userId: session.userId,
        organizationId: session.organizationId,
        sessionId: session.id,
        email: session.user.email,
        fullName: session.user.fullName,
        permissions: await this.rbac.loadPermissionSet(session.userId, session.organizationId),
      },
      expiresAt: tokenExpiry < session.expiresAt ? tokenExpiry : session.expiresAt,
    };
  }

  /** Revoked sessions end live connections too. */
  async isSessionLive(sessionId: string): Promise<boolean> {
    const s = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { revokedAt: true, expiresAt: true } });
    return !!s && !s.revokedAt && s.expiresAt > new Date();
  }
}
