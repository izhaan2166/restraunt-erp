import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/auth.decorators';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis | null,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness: ready only when PostgreSQL (the source of truth) answers. Redis, when configured,
   * is reported but does not fail readiness: the API keeps serving (rate limits fall back open).
   */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => 'up' as const, () => 'down' as const),
      this.redis ? this.redis.ping().then(() => 'up' as const, () => 'down' as const) : Promise.resolve('not_configured' as const),
    ]);
    if (database === 'down') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable', database, redis };
    }
    return { status: redis === 'down' ? 'degraded' : 'ok', database, redis };
  }
}
