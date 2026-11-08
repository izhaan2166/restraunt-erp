import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { Env, ENV } from '../../config/env';
import { Errors } from '../../common/errors/app-error';

export interface AccessClaims {
  sub: string;
  org: string;
  sid: string;
  typ: 'access';
  /** Set by the JWT library on signed tokens (seconds since epoch). */
  exp?: number;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 256-bit random opaque token, URL-safe. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  signAccessToken(claims: Omit<AccessClaims, 'typ'>): { token: string; expiresIn: number } {
    const expiresIn = this.env.ACCESS_TOKEN_TTL_SECONDS;
    const token = this.jwt.sign(
      { ...claims, typ: 'access' },
      {
        secret: this.env.JWT_ACCESS_SECRET,
        algorithm: 'HS256',
        expiresIn,
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
      },
    );
    return { token, expiresIn };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const claims = await this.jwt.verifyAsync<AccessClaims>(token, {
        secret: this.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
      });
      if (claims.typ !== 'access' || !claims.sub || !claims.sid || !claims.org) throw new Error('bad claims');
      return claims;
    } catch {
      throw Errors.unauthenticated('INVALID_ACCESS_TOKEN', 'Access token is invalid or expired');
    }
  }
}
