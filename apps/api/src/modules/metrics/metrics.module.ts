import { Global, Injectable, MiddlewareConsumer, Module, NestMiddleware, NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Times every request. The route label is the matched template (`/api/v1/orders/:id`), never the
 * raw URL, so ids do not explode the number of series. Unmatched paths share one label.
 */
@Injectable()
class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}
  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path;
      const full = route ? `${req.baseUrl ?? ''}${route}` : '';
      // 404s land on the catch-all wildcard; they all share one label.
      const template = full && !full.includes('{*') ? full : 'unmatched';
      if (template.endsWith('/metrics')) return;
      this.metrics.observe(req.method, template, res.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  }
}

@Global()
@Module({ controllers: [MetricsController], providers: [MetricsService, HttpMetricsMiddleware], exports: [MetricsService] })
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*splat}');
  }
}
