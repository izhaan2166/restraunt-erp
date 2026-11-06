import { JwtService } from '@nestjs/jwt';
import { loadEnv } from '../../config/env';
import { TokenService, randomToken, sha256 } from './token.service';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'unit-test-secret-0123456789abcdef0123',
} as NodeJS.ProcessEnv);

describe('TokenService', () => {
  const jwt = new JwtService();
  const svc = new TokenService(jwt, env);
  const claims = { sub: 'u1', org: 'o1', sid: 's1' };

  it('round-trips access claims', async () => {
    const { token, expiresIn } = svc.signAccessToken(claims);
    expect(expiresIn).toBe(900);
    await expect(svc.verifyAccessToken(token)).resolves.toEqual(expect.objectContaining({ ...claims, typ: 'access' }));
  });

  it('rejects tokens signed with another secret', async () => {
    const forged = jwt.sign({ ...claims, typ: 'access' }, { secret: 'x'.repeat(40), issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE });
    await expect(svc.verifyAccessToken(forged)).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
  });

  it('rejects the wrong token type, audience, or an expired token', async () => {
    const opts = { secret: env.JWT_ACCESS_SECRET, issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE };
    await expect(svc.verifyAccessToken(jwt.sign({ ...claims, typ: 'refresh' }, opts))).rejects.toBeDefined();
    await expect(
      svc.verifyAccessToken(jwt.sign({ ...claims, typ: 'access' }, { ...opts, audience: 'someone-else' })),
    ).rejects.toBeDefined();
    await expect(
      svc.verifyAccessToken(jwt.sign({ ...claims, typ: 'access', exp: Math.floor(Date.now() / 1000) - 10 }, opts)),
    ).rejects.toBeDefined();
  });

  it('rejects alg=none tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...claims, typ: 'access' })).toString('base64url');
    await expect(svc.verifyAccessToken(`${header}.${body}.`)).rejects.toBeDefined();
  });
});

describe('opaque tokens', () => {
  it('are 256-bit and URL-safe; hashes are hex sha-256', () => {
    const t = randomToken();
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sha256(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(t);
  });
});
