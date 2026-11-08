import Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';

// CI runs a Redis service; locally: `redis-server` then TEST_REDIS_URL=redis://localhost:6379/15.
const url = process.env.TEST_REDIS_URL;
const maybe = url ? describe : describe.skip;

maybe('RedisThrottlerStorage', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(url!, { maxRetriesPerRequest: 1 });
  });
  afterAll(() => redis.quit());

  it('counts hits in a window shared by every instance and blocks past the limit', async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const a = new RedisThrottlerStorage(redis, 'ros:test');
    const b = new RedisThrottlerStorage(redis, 'ros:test');
    expect(await a.increment(key, 60_000, 3, 5_000, 'auth')).toEqual(expect.objectContaining({ totalHits: 1, isBlocked: false }));
    expect((await b.increment(key, 60_000, 3, 5_000, 'auth')).totalHits).toBe(2);
    expect((await a.increment(key, 60_000, 3, 5_000, 'auth')).isBlocked).toBe(false);
    const over = await b.increment(key, 60_000, 3, 5_000, 'auth');
    expect(over).toEqual(expect.objectContaining({ isBlocked: true, timeToBlockExpire: 5 }));
    expect((await a.increment(key, 60_000, 3, 5_000, 'auth')).isBlocked).toBe(true);
    // Another throttler on the same client key has its own counter.
    expect((await a.increment(key, 60_000, 3, 5_000, 'default')).isBlocked).toBe(false);
  });

  it('starts a fresh window after the block ends', async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const s = new RedisThrottlerStorage(redis, 'ros:test');
    await s.increment(key, 60_000, 1, 200, 'x');
    expect((await s.increment(key, 60_000, 1, 200, 'x')).isBlocked).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(await s.increment(key, 60_000, 1, 200, 'x')).toEqual(expect.objectContaining({ totalHits: 1, isBlocked: false }));
  });
});

describe('RedisThrottlerStorage without Redis', () => {
  it('lets requests through instead of failing them', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    const s = new RedisThrottlerStorage(dead);
    expect(await s.increment('k', 60_000, 1, 1000, 'default')).toEqual(expect.objectContaining({ isBlocked: false }));
    dead.disconnect();
  });
});
