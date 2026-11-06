import { PasswordService, checkPasswordPolicy } from './password.service';

describe('password policy', () => {
  it.each([
    ['short1', false],
    ['onlyletterslong', false],
    ['1234567890123', false],
    ['GoodPass2026', true],
    ['a'.repeat(127) + '1', true],
    ['a'.repeat(128) + '1', false],
  ])('%s → %s', (pw, ok) => expect(checkPasswordPolicy(pw)).toBe(ok));
});

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await svc.hash('GoodPass2026');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(hash, 'GoodPass2026')).toBe(true);
    expect(await svc.verify(hash, 'goodpass2026')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await svc.hash('GoodPass2026')).not.toBe(await svc.hash('GoodPass2026'));
  });

  it('returns false instead of throwing on a corrupt hash', async () => {
    expect(await svc.verify('not-a-hash', 'x')).toBe(false);
  });
});
