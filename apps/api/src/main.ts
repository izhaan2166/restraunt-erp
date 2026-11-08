import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app, env);
  const logger = app.get(Logger);

  // Last-resort error tracking: anything that escapes a request ends up in the structured log
  // (and so in the log pipeline's alerts) instead of vanishing.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception; shutting down');
    // State may be corrupt: stop taking traffic and let the orchestrator restart the container.
    void app.close().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 10_000).unref();
  });

  await app.listen(env.PORT);
}

void main();
