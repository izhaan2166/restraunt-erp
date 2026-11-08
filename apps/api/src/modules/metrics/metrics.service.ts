import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

/**
 * Prometheus metrics for this API process: request rate, latency and errors per route, Node.js
 * runtime (memory, event-loop lag, GC), database and Redis reachability, and the realtime backlog.
 * Each instance has its own registry, so tests and multiple app instances never collide.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly httpTotal: Counter<'method' | 'route' | 'status'>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {
    this.registry.setDefaultLabels({ service: 'restaurant-os-api' });
    collectDefaultMetrics({ register: this.registry, prefix: 'ros_' });
    this.httpDuration = new Histogram({
      name: 'ros_http_request_duration_seconds',
      help: 'HTTP request duration by route template',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.httpTotal = new Counter({
      name: 'ros_http_requests_total',
      help: 'HTTP requests by route template and status',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    const prismaRef = this.prisma;
    new Gauge({
      name: 'ros_realtime_outbox_backlog',
      help: 'Realtime events committed but not yet published to clients',
      registers: [this.registry],
      async collect() {
        try {
          const [r] = await prismaRef.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM realtime_events WHERE seq IS NULL`;
          this.set(Number(r.n));
        } catch {
          this.set(-1);
        }
      },
    });
    new Gauge({
      name: 'ros_database_up',
      help: '1 when PostgreSQL answers a trivial query',
      registers: [this.registry],
      async collect() {
        this.set(await prismaRef.$queryRaw`SELECT 1`.then(() => 1, () => 0));
      },
    });
    const redisRef = this.redis;
    new Gauge({
      name: 'ros_redis_up',
      help: '1 when Redis answers PING (absent when Redis is not configured)',
      registers: [this.registry],
      async collect() {
        if (!redisRef) return;
        this.set(await redisRef.ping().then(() => 1, () => 0));
      },
    });
  }

  observe(method: string, route: string, status: number, seconds: number) {
    const labels = { method, route, status: String(status) };
    this.httpDuration.observe(labels, seconds);
    this.httpTotal.inc(labels);
  }
}
