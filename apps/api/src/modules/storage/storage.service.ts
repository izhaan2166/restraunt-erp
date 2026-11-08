import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Env, ENV } from '../../config/env';

export const LOCAL_UPLOAD_PREFIX = '/uploads';

/** Stores uploaded files on local disk (development) or any S3-compatible bucket (production). */
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
    if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(key) || key.includes('..')) throw new Error(`Unsafe storage key: ${key}`);
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.env.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      return `${this.env.S3_PUBLIC_BASE_URL!.replace(/\/$/, '')}/${key}`;
    }
    const root = resolve(this.env.UPLOAD_DIR);
    const path = resolve(join(root, key));
    if (!path.startsWith(root)) throw new Error('Storage key escapes upload directory');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { flag: 'wx' });
    return `${LOCAL_UPLOAD_PREFIX}/${key}`;
  }
}
