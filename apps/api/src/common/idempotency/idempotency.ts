import {
  CallHandler,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  NestInterceptor,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { Observable, from, of, switchMap, catchError, throwError } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthedRequest } from '../../modules/auth/principal';
import { Errors } from '../errors/app-error';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,100}$/;
const TTL_MS = 24 * 3600_000;

/** Deterministic JSON (sorted keys) so the same request always hashes the same. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Makes a money-moving POST safe to retry. The client sends `Idempotency-Key`; the first request
 * with a key runs and its response is stored; a retry with the same key and the same body gets
 * the stored response (header `Idempotent-Replayed: true`) without running again; the same key
 * with a different body is refused. A request that fails releases its key so it can be retried.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const user = req.user!;
    const key = req.header('idempotency-key');
    if (!key) throw Errors.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (a UUID) with this request');
    if (!KEY_FORMAT.test(key)) throw Errors.badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8–100 characters of A–Z, a–z, 0–9, _ or -');
    const scope = `${req.method} ${req.route?.path ?? req.path}`.slice(0, 80);
    const requestHash = createHash('sha256').update(stableStringify({ params: req.params, body: req.body })).digest('hex');
    const where = { organizationId_scope_key: { organizationId: user.organizationId, scope, key } };

    return from(this.claim(user.organizationId, user.userId, scope, key, requestHash)).pipe(
      switchMap((claimed) => {
        if (claimed.replay) {
          res.setHeader('Idempotent-Replayed', 'true');
          if (claimed.status) res.status(claimed.status);
          return of(claimed.body);
        }
        return next.handle().pipe(
          switchMap((result) =>
            from(
              this.prisma.idempotencyKey.update({
                where,
                data: {
                  status: 'COMPLETED',
                  responseStatus: res.statusCode,
                  responseBody: (result === undefined ? Prisma.JsonNull : JSON.parse(JSON.stringify(result))) as Prisma.InputJsonValue,
                },
              }),
            ).pipe(switchMap(() => of(result))),
          ),
          catchError((err) => from(this.prisma.idempotencyKey.deleteMany({ where: { organizationId: user.organizationId, scope, key } })).pipe(switchMap(() => throwError(() => err)))),
        );
      }),
    );
  }

  private async claim(organizationId: string, userId: string, scope: string, key: string, requestHash: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.prisma.idempotencyKey.create({
          data: { organizationId, userId, scope, key, requestHash, expiresAt: new Date(Date.now() + TTL_MS) },
        });
        return { replay: false as const };
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
      const existing = await this.prisma.idempotencyKey.findUnique({ where: { organizationId_scope_key: { organizationId, scope, key } } });
      if (!existing) continue; // released between our insert and read: try again
      if (existing.expiresAt < new Date()) {
        await this.prisma.idempotencyKey.deleteMany({ where: { id: existing.id } });
        continue;
      }
      if (existing.requestHash !== requestHash || existing.userId !== userId) {
        throw Errors.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }
      if (existing.status === 'COMPLETED') {
        return { replay: true as const, status: existing.responseStatus ?? 200, body: existing.responseBody ?? undefined };
      }
      throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed; retry shortly');
    }
    throw Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed; retry shortly');
  }
}

/** Marks a route as requiring an `Idempotency-Key` header. */
export const Idempotent = () =>
  applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Unique per logical operation (a UUID). Retries reuse it.' }),
  );

@Global()
@Module({ providers: [IdempotencyInterceptor], exports: [IdempotencyInterceptor] })
export class IdempotencyModule {}
