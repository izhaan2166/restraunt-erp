import { loadEnv } from './env';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 's'.repeat(32) };

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it('turns on secure cookies and turns off Swagger in production by default', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('fails fast on a weak JWT secret', () => {
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_ACCESS_SECRET/);
  });
});
