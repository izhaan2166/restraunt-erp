import { Controller, Get, Inject, NotFoundException, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/decorators/auth.decorators';
import { ENV, Env } from '../../config/env';
import { MetricsService } from './metrics.service';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Prometheus scrape endpoint. Off unless METRICS_TOKEN is set; the scraper sends it as a Bearer token. */
@ApiExcludeController()
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Get()
  async scrape(@Req() req: Request, @Res() res: Response) {
    if (!this.env.METRICS_TOKEN) throw new NotFoundException();
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!timingSafeEqual(digest(given), digest(this.env.METRICS_TOKEN))) throw new UnauthorizedException();
    res.setHeader('Cache-Control', 'no-store');
    res.type(this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }
}
