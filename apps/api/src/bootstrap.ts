import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { Env } from './config/env';

/** Shared HTTP setup used by main.ts and the e2e test harness, so tests exercise the real stack. */
export function configureApp(app: INestApplication, env: Env): void {
  const express = app as NestExpressApplication;
  app.useLogger(app.get(Logger));
  express.set('trust proxy', env.TRUST_PROXY);
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: '1mb' });

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Branch-Id', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.enableShutdownHooks();

  if (env.SWAGGER_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle('RestaurantOS API')
      .setDescription(
        'Restaurant ERP & POS. All responses are `{ data, meta? }`; errors are `{ error: { code, message, details?, requestId } }`.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Branch-Id' }, 'branch')
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config), {
      jsonDocumentUrl: 'api/docs-json',
    });
  }
}
