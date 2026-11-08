import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

/** ThrottlerStorage's record type (not exported from the package root in every version). */
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Fixed window per key, plus a block key once the limit is passed. One round trip, atomic.
 * KEYS[1] = hits, KEYS[2] = block; ARGV = ttl ms, limit, block ms. Returns hits, ttl ms, blocked, block ms.
 */
const SCRIPT = `
local bttl = redis.call('PTTL', KEYS[2])
if bttl > 0 then
  return {tonumber(ARGV[2]) + 1, bttl, 1, bttl}
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  redis.call('DEL', KEYS[1])
  return {hits, ttl, 1, tonumber(ARGV[3])}
end
return {hits, ttl, 0, 0}
`;

/**
 * Rate-limit counters in Redis, so every API instance behind the load balancer shares the same
 * limits. If Redis is unreachable the request is allowed (and logged): an outage of the cache
 * must not take the POS down. Login brute force stays covered by the account lockout in PostgreSQL.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RateLimit');
  private lastWarn = 0;

  constructor(private readonly redis: Redis, private readonly prefix = 'ros:rl') {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    // The hash tag keeps both keys in one slot on Redis Cluster.
    const base = `${this.prefix}:{${throttlerName}:${key}}`;
    try {
      const [hits, ttlMs, blocked, blockMs] = (await this.redis.eval(SCRIPT, 2, `${base}:h`, `${base}:b`, ttl, limit, Math.max(blockDuration, 1))) as number[];
      return { totalHits: hits, timeToExpire: Math.ceil(ttlMs / 1000), isBlocked: blocked === 1, timeToBlockExpire: Math.ceil(blockMs / 1000) };
    } catch (err) {
      if (Date.now() - this.lastWarn > 60_000) {
        this.lastWarn = Date.now();
        this.logger.warn({ err: (err as Error).message }, 'Redis unavailable; rate limits are not enforced until it is back');
      }
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
