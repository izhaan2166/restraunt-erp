import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the API is only ready when PostgreSQL (the source of truth) answers. */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable', database: 'down' };
    }
  }
}
