import type { Request } from 'express';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export function requestMeta(req: Request & { id?: unknown }): RequestMeta {
  return {
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 500),
    requestId: typeof req.id === 'string' ? req.id : undefined,
  };
}
