import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Env, ENV } from '../../config/env';

export const LOCAL_UPLOAD_PREFIX = '/uploads';

/** A private file, ready to send: either its bytes (local disk) or a short-lived signed URL (S3). */
export type PrivateFile = { kind: 'bytes'; body: Buffer } | { kind: 'redirect'; url: string };

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]*$/i;

/**
 * Stores uploaded files on local disk (development, self-hosted) or any S3-compatible bucket.
 * Public files (menu images) get a permanent public URL. Private files (expense receipts) are
 * kept out of the public folder and only ever reach a user through an authenticated API route.
 */
@Injectable()
export class StorageService {
  private s3?: S3Client;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.STORAGE_DRIVER === 's3') {
      this.s3 = new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials:
          env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
    }
  }

  /** `key` must be generated server-side (never from client input). Returns the public URL. */
  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    assertKey(key);
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }),
      );
      return `${this.env.S3_PUBLIC_BASE_URL!.replace(/\/$/, '')}/${key}`;
    }
    await writeLocal(this.env.UPLOAD_DIR, key, body);
    return `${LOCAL_UPLOAD_PREFIX}/${key}`;
  }

  /**
   * Stores a private document. On S3 the bucket (or at least this prefix) must not be public;
   * the object is marked `private, no-store` so shared caches never keep it.
   */
  async putPrivate(key: string, body: Buffer, contentType: string): Promise<void> {
    assertKey(key);
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, no-store' }),
      );
      return;
    }
    await writeLocal(this.env.PRIVATE_UPLOAD_DIR, key, body);
  }

  /** Reads a private document for an already-authorised request. */
  async getPrivate(key: string): Promise<PrivateFile> {
    assertKey(key);
    if (this.s3) {
      const cmd = new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key, ResponseCacheControl: 'private, no-store' });
      return { kind: 'redirect', url: await getSignedUrl(this.s3, cmd, { expiresIn: this.env.S3_PRESIGN_SECONDS }) };
    }
    try {
      return { kind: 'bytes', body: await readFile(localPath(this.env.PRIVATE_UPLOAD_DIR, key)) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // Receipts uploaded before they became private live in the public folder (which no longer serves them).
      return { kind: 'bytes', body: await readFile(localPath(this.env.UPLOAD_DIR, key)) };
    }
  }
}

function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe storage key: ${key}`);
}

function localPath(dir: string, key: string) {
  const root = resolve(dir);
  const path = resolve(join(root, key));
  if (!path.startsWith(root + '/')) throw new Error('Storage key escapes upload directory');
  return path;
}

async function writeLocal(dir: string, key: string, body: Buffer) {
  const path = localPath(dir, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { flag: 'wx' });
}
