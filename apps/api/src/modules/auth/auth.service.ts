import { Inject, Injectable } from '@nestjs/common';
import { Env, ENV } from '../../config/env';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { RbacService } from '../rbac/rbac.service';
import { PASSWORD_POLICY, PasswordService, checkPasswordPolicy } from './password.service';
import { TokenService, randomToken, sha256 } from './token.service';
import type { AuthPrincipal } from './principal';

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly rbac: RbacService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────── Login ─────────────

  async login(email: string, password: string, meta: RequestMeta): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const now = new Date();

    if (!user || user.deletedAt || !user.isActive) {
      await this.passwords.verifyDummy(password);
      await this.audit.record({
        organizationId: user?.organizationId ?? null,
        actorUserId: null,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user?.id,
        metadata: { email, reason: user ? 'inactive' : 'unknown_email' },
        meta,
      });
      throw Errors.unauthenticated('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    if (user.lockedUntil && user.lockedUntil > now) {
      throw Errors.locked('Too many failed attempts. Try again later or reset your password.');
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      // Atomic increment so concurrent bad attempts are all counted.
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true },
      });
      const lock = updated.failedLoginAttempts >= this.env.LOGIN_MAX_FAILED_ATTEMPTS;
      if (lock) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: 0,
            lockedUntil: new Date(now.getTime() + this.env.LOGIN_LOCKOUT_SECONDS * 1000),
          },
        });
      }
      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: null,
        action: lock ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        metadata: { reason: 'bad_password' },
        meta,
      });
      throw Errors.unauthenticated('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
      });
      const issued = await this.startSession(tx, user.id, user.organizationId, meta);
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'auth.login',
          entityType: 'session',
          entityId: issued.sessionId,
          meta,
        },
        tx,
      );
      return issued.tokens;
    });
  }

  // ───────────── Refresh (rotation + reuse detection) ─────────────

  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<IssuedTokens> {
    if (!rawToken) throw Errors.unauthenticated('REFRESH_TOKEN_MISSING', 'Refresh token is required');
    const now = new Date();
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { session: { include: { user: true } } },
    });
    if (!stored) throw Errors.unauthenticated('INVALID_REFRESH_TOKEN', 'Refresh token is invalid');

    const { session } = stored;
    if (stored.usedAt || stored.revokedAt) {
      // A rotated token came back: assume it was stolen and kill the whole session family.
      await this.revokeSession(session.id, 'refresh_token_reuse');
      await this.audit.record({
        organizationId: session.organizationId,
        actorUserId: session.userId,
        action: 'auth.refresh_token_reuse',
        entityType: 'session',
        entityId: session.id,
        meta,
      });
      throw Errors.unauthenticated('REFRESH_TOKEN_REUSED', 'Refresh token was already used; session revoked');
    }
    if (
      stored.expiresAt <= now ||
      session.revokedAt ||
      session.expiresAt <= now ||
      !session.user.isActive ||
      session.user.deletedAt
    ) {
      throw Errors.unauthenticated('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
    }

    return this.prisma.$transaction(async (tx) => {
      // Compare-and-set: of two concurrent refreshes with the same token only one wins.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, usedAt: null, revokedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw Errors.unauthenticated('REFRESH_TOKEN_REUSED', 'Refresh token was already used');
      }
      const next = await this.issueRefreshToken(tx, session.id, session.expiresAt);
      await tx.refreshToken.update({ where: { id: stored.id }, data: { replacedById: next.id } });
      await tx.session.update({ where: { id: session.id }, data: { lastUsedAt: now, ip: meta.ip } });
      const access = this.tokens.signAccessToken({ sub: session.userId, org: session.organizationId, sid: session.id });
      return {
        accessToken: access.token,
        expiresIn: access.expiresIn,
        refreshToken: next.raw,
        refreshExpiresAt: next.expiresAt,
      };
    });
  }

  // ───────────── Logout ─────────────

  async logout(principal: AuthPrincipal, meta: RequestMeta, allSessions = false): Promise<void> {
    if (allSessions) {
      await this.revokeAllSessions(principal.userId, 'logout_all');
    } else {
      await this.revokeSession(principal.sessionId, 'logout');
    }
    await this.audit.record({
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      action: allSessions ? 'auth.logout_all' : 'auth.logout',
      entityType: 'session',
      entityId: principal.sessionId,
      meta,
    });
  }

  /** Logout via refresh token alone (browser cookie), used when the access token has expired. */
  async logoutByRefreshToken(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
    if (!rawToken) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { session: true },
    });
    if (!stored || stored.session.revokedAt) return;
    await this.revokeSession(stored.sessionId, 'logout');
    await this.audit.record({
      organizationId: stored.session.organizationId,
      actorUserId: stored.session.userId,
      action: 'auth.logout',
      entityType: 'session',
      entityId: stored.sessionId,
      meta,
    });
  }

  // ───────────── Password reset ─────────────

  /** Always resolves the same way so the response never reveals whether the email exists. */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || user.deletedAt) return;

    const raw = randomToken();
    const expiresAt = new Date(Date.now() + this.env.PASSWORD_RESET_TTL_SECONDS * 1000);
    await this.prisma.$transaction(async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(raw), expiresAt } });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorUserId: null,
          action: 'auth.password_reset_requested',
          entityType: 'user',
          entityId: user.id,
          meta,
        },
        tx,
      );
    });
    const link = `${this.env.APP_PUBLIC_URL}/reset-password?token=${encodeURIComponent(raw)}`;
    await this.mail.send({
      to: user.email,
      subject: 'Reset your RestaurantOS password',
      text: `Hi ${user.fullName},\n\nUse this link within ${Math.round(
        this.env.PASSWORD_RESET_TTL_SECONDS / 60,
      )} minutes to reset your password:\n${link}\n\nIf you did not request this, ignore this email.`,
    });
  }

  async resetPassword(rawToken: string, newPassword: string, meta: RequestMeta): Promise<void> {
    if (!checkPasswordPolicy(newPassword)) throw Errors.badRequest('WEAK_PASSWORD', PASSWORD_POLICY);
    const now = new Date();
    const stored = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: true },
    });
    if (!stored || stored.usedAt || stored.expiresAt <= now || !stored.user.isActive || stored.user.deletedAt) {
      throw Errors.badRequest('INVALID_RESET_TOKEN', 'Reset link is invalid or has expired');
    }
    const hash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: stored.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw Errors.badRequest('INVALID_RESET_TOKEN', 'Reset link is invalid or has expired');
      await tx.user.update({
        where: { id: stored.userId },
        data: { passwordHash: hash, passwordChangedAt: now, failedLoginAttempts: 0, lockedUntil: null },
      });
      await this.revokeAllSessions(stored.userId, 'password_reset', tx);
      await this.audit.record(
        {
          organizationId: stored.user.organizationId,
          actorUserId: stored.userId,
          action: 'auth.password_reset',
          entityType: 'user',
          entityId: stored.userId,
          meta,
        },
        tx,
      );
    });
  }

  async changePassword(principal: AuthPrincipal, current: string, next: string, meta: RequestMeta): Promise<void> {
    if (!checkPasswordPolicy(next)) throw Errors.badRequest('WEAK_PASSWORD', PASSWORD_POLICY);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: principal.userId } });
    if (!(await this.passwords.verify(user.passwordHash, current))) {
      throw Errors.badRequest('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
    }
    const hash = await this.passwords.hash(next);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: hash, passwordChangedAt: new Date() } });
      // Keep the current device signed in, sign out every other one.
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, NOT: { id: principal.sessionId } },
        data: { revokedAt: new Date(), revokeReason: 'password_changed' },
      });
      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: user.id,
          meta,
        },
        tx,
      );
    });
  }

  // ───────────── Me ─────────────

  async me(principal: AuthPrincipal) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      include: { organization: { select: { id: true, name: true, gstin: true, stateCode: true } } },
    });
    const branchesAccess = principal.permissions.accessibleBranches();
    const branches = await this.prisma.branch.findMany({
      where: {
        organizationId: principal.organizationId,
        deletedAt: null,
        ...(branchesAccess === 'ALL' ? {} : { id: { in: branchesAccess } }),
      },
      select: { id: true, code: true, name: true, stateCode: true },
      orderBy: { name: 'asc' },
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        lastLoginAt: user.lastLoginAt,
      },
      organization: user.organization,
      roles: principal.permissions.assignments.map((a) => ({ roleId: a.roleId, roleKey: a.roleKey, branchId: a.branchId })),
      permissions: {
        organizationWide: [...principal.permissions.effective(null)].sort(),
        byBranch: Object.fromEntries(
          branches.map((b) => [b.id, [...principal.permissions.effective(b.id)].sort()]),
        ),
      },
      branches,
    };
  }

  // ───────────── Internals ─────────────

  private async startSession(tx: Tx, userId: string, organizationId: string, meta: RequestMeta) {
    const now = Date.now();
    const session = await tx.session.create({
      data: {
        userId,
        organizationId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(now + this.env.SESSION_MAX_AGE_SECONDS * 1000),
      },
    });
    const refresh = await this.issueRefreshToken(tx, session.id, session.expiresAt);
    const access = this.tokens.signAccessToken({ sub: userId, org: organizationId, sid: session.id });
    return {
      sessionId: session.id,
      tokens: {
        accessToken: access.token,
        expiresIn: access.expiresIn,
        refreshToken: refresh.raw,
        refreshExpiresAt: refresh.expiresAt,
      },
    };
  }

  private async issueRefreshToken(tx: Tx, sessionId: string, sessionExpiresAt: Date) {
    const raw = randomToken();
    const ttlEnd = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const expiresAt = ttlEnd < sessionExpiresAt ? ttlEnd : sessionExpiresAt;
    const row = await tx.refreshToken.create({ data: { sessionId, tokenHash: sha256(raw), expiresAt } });
    return { id: row.id, raw, expiresAt };
  }

  async revokeSession(sessionId: string, reason: string, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    const now = new Date();
    await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now, revokeReason: reason } });
    await db.refreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: now } });
  }

  async revokeAllSessions(userId: string, reason: string, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    const now = new Date();
    await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokeReason: reason } });
    await db.refreshToken.updateMany({
      where: { session: { userId }, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Exposed for other modules that need a fresh permission view inside a transaction. */
  loadPermissions(userId: string, organizationId: string, tx?: Tx) {
    return this.rbac.loadPermissionSet(userId, organizationId, tx);
  }
}
