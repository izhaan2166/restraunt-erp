import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import type { RequestMeta } from '../../common/http/request-meta';
import { Paginated } from '../../common/dto/pagination';
import type { AuditQueryDto } from './dto/audit-query.dto';

export interface AuditEntry {
  organizationId: string | null;
  branchId?: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
}

const SENSITIVE_KEYS = new Set(['passwordHash', 'password', 'tokenHash', 'token', 'refreshToken']);

/**
 * Writes append-only audit records. Pass the transaction client when the audited change is
 * transactional so the audit row commits (or rolls back) together with the change.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        branchId: entry.branchId ?? null,
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        metadata: toJson(entry.metadata),
        ip: entry.meta?.ip,
        userAgent: entry.meta?.userAgent,
        requestId: entry.meta?.requestId,
      },
    });
  }

  async list(organizationId: string, branchId: string | null, q: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      ...(branchId ? { branchId } : {}),
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { id: q.order }, skip: q.skip, take: q.pageSize }),
      this.prisma.auditLog.count({ where }),
    ]);
    return new Paginated(
      rows.map((r) => ({ ...r, id: r.id.toString() })),
      total,
      q,
    );
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) => {
      if (SENSITIVE_KEYS.has(key)) return '[REDACTED]';
      if (typeof v === 'bigint') return v.toString();
      return v;
    }),
  ) as Prisma.InputJsonValue;
}
