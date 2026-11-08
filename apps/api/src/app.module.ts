import { Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ENV, Env, loadEnv } from './config/env';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BranchesModule } from './modules/branches/branches.module';
import { HealthController } from './modules/health/health.controller';
import { MailModule } from './modules/mail/mail.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { UsersModule } from './modules/users/users.module';
import { KitchenStationsModule } from './modules/kitchen-stations/kitchen-stations.module';
import { MenuModule } from './modules/menu/menu.module';
import { StorageModule } from './modules/storage/storage.module';
import { TablesModule } from './modules/tables/tables.module';
import { TaxesModule } from './modules/taxes/taxes.module';
import { Global } from '@nestjs/common';
import { AUTH_THROTTLE } from './common/decorators/auth.decorators';

@Global()
@Module({ providers: [{ provide: ENV, useFactory: () => loadEnv() }], exports: [ENV] })
class ConfigModule {}

const env = loadEnv();

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      forRoutes: [{ path: '{*splat}', method: RequestMethod.ALL }],
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: (req: IncomingMessage) => {
          const incoming = req.headers['x-request-id'];
          return typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        },
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          censor: '[REDACTED]',
        },
        customProps: (req) => ({ userId: (req as IncomingMessage & { user?: { userId: string } }).user?.userId }),
        transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health') },
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (e: Env) => [
        { name: 'default', ttl: 60_000, limit: e.RATE_LIMIT_PER_MINUTE },
        // Stricter per-IP bucket, only for routes marked @AuthThrottle() (login, refresh, reset…).
        {
          name: 'auth',
          ttl: 60_000,
          limit: e.AUTH_RATE_LIMIT_PER_MINUTE,
          skipIf: (ctx) => !Reflect.getMetadata(AUTH_THROTTLE, ctx.getHandler()),
        },
      ],
    }),
    PrismaModule,
    MailModule,
    AuditModule,
    RbacModule,
    AuthModule,
    OrganizationsModule,
    BranchesModule,
    UsersModule,
    StorageModule,
    TaxesModule,
    KitchenStationsModule,
    MenuModule,
    TablesModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
