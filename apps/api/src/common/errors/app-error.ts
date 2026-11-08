import { HttpStatus } from '@nestjs/common';

/**
 * Domain error carrying a stable machine-readable code. Services throw these;
 * the global exception filter renders them in the standard error envelope.
 */
export class AppError extends Error {
  constructor(
    public readonly status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details?: unknown) =>
    new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Request validation failed', details),
  badRequest: (code: string, message: string, details?: unknown) =>
    new AppError(HttpStatus.BAD_REQUEST, code, message, details),
  unauthenticated: (code = 'UNAUTHENTICATED', message = 'Authentication required') =>
    new AppError(HttpStatus.UNAUTHORIZED, code, message),
  forbidden: (code = 'FORBIDDEN', message = 'You do not have permission to perform this action', details?: unknown) =>
    new AppError(HttpStatus.FORBIDDEN, code, message, details),
  notFound: (entity: string) => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${entity} not found`),
  conflict: (code: string, message: string, details?: unknown) =>
    new AppError(HttpStatus.CONFLICT, code, message, details),
  locked: (message: string) => new AppError(HttpStatus.LOCKED, 'ACCOUNT_LOCKED', message),
  unprocessable: (code: string, message: string, details?: unknown) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details),
  gone: (code: string, message: string, details?: unknown) => new AppError(HttpStatus.GONE, code, message, details),
};
