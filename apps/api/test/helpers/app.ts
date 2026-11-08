import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadEnv } from '../../src/config/env';
import { MailService, MemoryMailService } from '../../src/modules/mail/mail.service';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  mail: MemoryMailService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app, loadEnv());
  await app.init();
  const prisma = app.get(PrismaService);
  const mail = app.get(MailService) as MemoryMailService;
  return {
    app,
    prisma,
    mail,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const API = '/api/v1';
