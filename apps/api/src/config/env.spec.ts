import { loadEnv } from './env';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 's'.repeat(32) };

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
    expect(env.COOKIE_SECURE).toBe(false);
  });

  const prod = {
    ...base,
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'q7Vb9xLp2Rk4Mz8Nw1Ty6Hs3Jd5Fg0Ca',
    CORS_ORIGINS: 'https://pos.example.in,https://admin.example.in',
    APP_PUBLIC_URL: 'https://pos.example.in',
  };

  it('turns on secure cookies and turns off Swagger in production by default', () => {
    const env = loadEnv({ ...prod } as NodeJS.ProcessEnv);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('fails fast on a weak JWT secret', () => {
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses unsafe settings in production', () => {
    const fails = (over: Record<string, string>, field: RegExp) => expect(() => loadEnv({ ...prod, ...over } as NodeJS.ProcessEnv)).toThrow(field);
    fails({ CORS_ORIGINS: '*' }, /CORS_ORIGINS/);
    fails({ CORS_ORIGINS: 'http://localhost:3000' }, /CORS_ORIGINS/);
    fails({ CORS_ORIGINS: 'http://pos.example.in' }, /CORS_ORIGINS/);
    fails({ MAIL_TRANSPORT: 'memory' }, /MAIL_TRANSPORT/);
    fails({ COOKIE_SECURE: 'false' }, /COOKIE_SECURE/);
    fails({ APP_PUBLIC_URL: 'http://pos.example.in' }, /APP_PUBLIC_URL/);
    fails({ JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef' }, /JWT_ACCESS_SECRET/);
    fails({ JWT_ACCESS_SECRET: 'a'.repeat(40) }, /JWT_ACCESS_SECRET/);
    // Development keeps its convenient defaults.
    expect(() => loadEnv({ ...base, CORS_ORIGINS: 'http://localhost:3000' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('needs an SMTP URL for the smtp transport', () => {
    expect(() => loadEnv({ ...base, MAIL_TRANSPORT: 'smtp' } as NodeJS.ProcessEnv)).toThrow(/SMTP_URL/);
    expect(loadEnv({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtps://u:p@smtp.example.in:465' } as NodeJS.ProcessEnv).MAIL_TRANSPORT).toBe('smtp');
  });
});
