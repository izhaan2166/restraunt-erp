import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, Env } from '../../config/env';

/** The shared Redis connection, or null when REDIS_URL is not set (single-instance deployments). */
export const REDIS = Symbol('REDIS');

@Injectable()
class RedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}
  async onApplicationShutdown() {
    await this.redis?.quit().catch(() => this.redis?.disconnect());
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis | null => {
        if (!env.REDIS_URL) return null;
        const logger = new Logger('Redis');
        // Fail fast instead of queueing: rate limiting must never stall requests while Redis is away.
        const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, lazyConnect: false });
        let down = false;
        redis.on('error', (err) => {
          if (!down) logger.error({ err: err.message }, 'Redis connection error');
          down = true;
        });
        redis.on('ready', () => {
          if (down) logger.log('Redis connection restored');
          down = false;
        });
        return redis;
      },
    },
    RedisCloser,
  ],
  exports: [REDIS],
})
export class RedisModule {}
