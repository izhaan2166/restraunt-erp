import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1). */
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_POLICY =
  'Password must be 10–128 characters and contain at least one letter and one digit';

export function checkPasswordPolicy(password: string): boolean {
  return (
    password.length >= 10 && password.length <= 128 && /[A-Za-z]/.test(password) && /[0-9]/.test(password)
  );
}

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON_OPTS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Burns comparable CPU time for unknown accounts so response timing does not reveal them. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-1');
    await this.verify(await this.dummyHash, password);
  }
}
