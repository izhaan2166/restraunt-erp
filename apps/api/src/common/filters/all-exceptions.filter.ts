import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppError } from '../errors/app-error';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/**
 * Single place that turns any thrown value into the standard error envelope.
 * Internal details (stack traces, SQL, constraint names) are logged, never returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    const { status, body } = this.toResponse(exception);
    body.error.requestId = requestId;

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId, path: req.originalUrl },
        exception instanceof Error ? exception.message : 'Unhandled error',
      );
    }
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: { error: { code: exception.code, message: exception.message, details: exception.details } },
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        body: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      if (status === HttpStatus.BAD_REQUEST && typeof resp === 'object' && resp && 'message' in resp) {
        const msg = (resp as { message: unknown }).message;
        if (Array.isArray(msg)) {
          return {
            status,
            body: { error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: msg } },
          };
        }
      }
      return {
        status,
        body: { error: { code: httpCode(status), message: exception.message } },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            body: {
              error: {
                code: 'UNIQUE_VIOLATION',
                message: 'A record with the same unique value already exists',
                details: { fields: (exception.meta?.target as string[] | undefined) ?? undefined },
              },
            },
          };
        case 'P2025':
          return { status: HttpStatus.NOT_FOUND, body: { error: { code: 'NOT_FOUND', message: 'Record not found' } } };
        case 'P2003':
          return {
            status: HttpStatus.CONFLICT,
            body: { error: { code: 'REFERENCE_VIOLATION', message: 'Referenced record does not exist or is in use' } },
          };
        case 'P2034':
          return {
            status: HttpStatus.CONFLICT,
            body: { error: { code: 'CONCURRENT_UPDATE', message: 'The record was changed concurrently; retry' } },
          };
      }
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
    };
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}
