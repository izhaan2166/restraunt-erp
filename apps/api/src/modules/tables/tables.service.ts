import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, TableStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import {
  CreateTableDto,
  ListTablesQuery,
  MergeTablesDto,
  OpenTableDto,
  OutOfServiceDto,
  ReserveTableDto,
  SaveLayoutDto,
  TransferTableDto,
  UpdateTableDto,
} from './dto/tables.dto';

type Tx = Prisma.TransactionClient;

const OPEN_SESSION = {
  sessions: {
    where: { closedAt: null },
    select: {
      id: true,
      guestCount: true,
      openedAt: true,
      openedById: true,
      mergedIntoId: true,
      mergedInto: { select: { tableId: true } },
      merged: { where: { closedAt: null }, select: { id: true, tableId: true } },
    },
  },
} satisfies Prisma.RestaurantTableInclude;

type TableRow = Prisma.RestaurantTableGetPayload<{ include: typeof OPEN_SESSION }>;

/** Orders in these states no longer block closing a table. */
const SETTLED: OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.CANCELLED];

/**
 * Floor plan and table operations. Every state change runs in a transaction that first takes a
 * row lock (SELECT … FOR UPDATE, in id order to avoid deadlocks) on each table it touches, so two
 * waiters opening the same table cannot both succeed; the partial unique index
 * `table_sessions_one_open_per_table` is the database-level backstop.
 */
@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Read ─────────────

  async list(actor: AuthPrincipal, branchId: string, q: ListTablesQuery) {
    const rows = await this.prisma.restaurantTable.findMany({
      where: { organizationId: actor.organizationId, branchId, deletedAt: null, area: q.area },
      orderBy: [{ area: 'asc' }, { label: 'asc' }],
      include: OPEN_SESSION,
    });
    return rows.map(present);
  }

  async get(actor: AuthPrincipal, branchId: string, id: string) {
    return present(await this.find(this.prisma, actor, branchId, id));
  }

  // ───────────── Manage ─────────────

  async create(actor: AuthPrincipal, branchId: string, dto: CreateTableDto, meta: RequestMeta) {
    const id = await this.prisma.$transaction(async (tx) => {
      const row = await tx.restaurantTable.create({
        data: { ...dto, label: dto.label.trim(), area: dto.area?.trim() || null, organizationId: actor.organizationId, branchId },
      });
      await this.log(tx, actor, branchId, 'table.created', row.id, undefined, row, meta);
      return row.id;
    });
    return this.get(actor, branchId, id);
  }

  async update(actor: AuthPrincipal, branchId: string, id: string, dto: UpdateTableDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const [before] = await this.lock(tx, actor, branchId, [id]);
      if (dto.version !== undefined && dto.version !== before.version) throw versionConflict(before.version);
      if (dto.isActive === false && before.sessions.length) throw Errors.conflict('TABLE_IN_USE', 'Close the table before deactivating it');
      const { version: _v, ...data } = dto;
      const after = await tx.restaurantTable.update({
        where: { id },
        data: { ...data, label: data.label?.trim(), area: data.area === undefined ? undefined : data.area.trim() || null, version: { increment: 1 } },
      });
      await this.log(tx, actor, branchId, 'table.updated', id, before, after, meta);
    });
    return this.get(actor, branchId, id);
  }

  async remove(actor: AuthPrincipal, branchId: string, id: string, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [before] = await this.lock(tx, actor, branchId, [id]);
      if (before.sessions.length) throw Errors.conflict('TABLE_IN_USE', 'Close the table before deleting it');
      // Soft delete keeps history; the label is suffixed so it can be reused for a new table.
      const label = `${before.label.slice(0, 11)}~${randomBytes(4).toString('hex')}`;
      await tx.restaurantTable.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false, label, version: { increment: 1 } },
      });
      await this.log(tx, actor, branchId, 'table.deleted', id, before, { label }, meta);
    });
  }

  /** Saves a drag-and-drop floor plan in one go. */
  async saveLayout(actor: AuthPrincipal, branchId: string, dto: SaveLayoutDto, meta: RequestMeta) {
    const ids = dto.tables.map((t) => t.id);
    if (new Set(ids).size !== ids.length) throw Errors.badRequest('DUPLICATE_TABLE', 'Each table may appear only once');
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, actor, branchId, ids);
      for (const t of dto.tables) {
        await tx.restaurantTable.update({
          where: { id: t.id },
          data: {
            posX: t.posX,
            posY: t.posY,
            width: t.width,
            height: t.height,
            shape: t.shape,
            area: t.area === undefined ? undefined : t.area.trim() || null,
            version: { increment: 1 },
          },
        });
      }
      await this.log(
        tx,
        actor,
        branchId,
        'table.layout_saved',
        null,
        before.map((b) => ({ id: b.id, posX: b.posX, posY: b.posY, width: b.width, height: b.height, shape: b.shape, area: b.area })),
        dto.tables,
        meta,
      );
    });
    return this.list(actor, branchId, {});
  }

  // ───────────── Operate ─────────────

  async open(actor: AuthPrincipal, branchId: string, id: string, dto: OpenTableDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const [t] = await this.lock(tx, actor, branchId, [id]);
      if (!t.isActive) throw Errors.conflict('TABLE_INACTIVE', 'This table is inactive');
      if (t.status !== TableStatus.AVAILABLE && t.status !== TableStatus.RESERVED) {
        throw Errors.conflict('TABLE_NOT_AVAILABLE', `Table ${t.label} is ${t.status.toLowerCase().replace('_', ' ')}`, { status: t.status });
      }
      const session = await tx.tableSession.create({
        data: { organizationId: actor.organizationId, branchId, tableId: id, guestCount: dto.guestCount, openedById: actor.userId },
      });
      await tx.restaurantTable.update({
        where: { id },
        data: { status: TableStatus.OCCUPIED, reservationName: null, reservationPhone: null, reservedUntil: null, version: { increment: 1 } },
      });
      await this.log(tx, actor, branchId, 'table.opened', id, { status: t.status }, { status: 'OCCUPIED', sessionId: session.id, guestCount: dto.guestCount }, meta);
    });
    return this.get(actor, branchId, id);
  }

  /** Closes the table's session and every table merged into it. All their orders must be settled. */
  async close(actor: AuthPrincipal, branchId: string, id: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const [first] = await this.lock(tx, actor, branchId, [id]);
      const session = openSessionOf(first);
      if (session.mergedIntoId) {
        throw Errors.conflict('TABLE_MERGED', `Table ${first.label} is merged into another table; close that table or split this one first`);
      }
      const secondaryTableIds = session.merged.map((m) => m.tableId);
      if (secondaryTableIds.length) await this.lock(tx, actor, branchId, secondaryTableIds);
      const sessionIds = [session.id, ...session.merged.map((m) => m.id)];

      const open = await tx.order.findMany({
        where: { tableSessionId: { in: sessionIds }, status: { notIn: SETTLED } },
        select: { id: true, orderNumber: true, status: true },
      });
      if (open.length) {
        throw Errors.conflict('TABLE_HAS_OPEN_ORDERS', 'Complete or cancel every order on this table before closing it', { orders: open });
      }
      const now = new Date();
      await tx.tableSession.updateMany({ where: { id: { in: sessionIds } }, data: { closedAt: now, closedById: actor.userId } });
      await tx.restaurantTable.updateMany({
        where: { id: { in: [id, ...secondaryTableIds] } },
        data: { status: TableStatus.AVAILABLE, version: { increment: 1 } },
      });
      await this.log(tx, actor, branchId, 'table.closed', id, { status: first.status, sessionId: session.id }, { status: 'AVAILABLE', closedTables: [id, ...secondaryTableIds] }, meta);
    });
    return this.get(actor, branchId, id);
  }

  /** Moves the party (session and its orders) to an available table. */
  async transfer(actor: AuthPrincipal, branchId: string, id: string, dto: TransferTableDto, meta: RequestMeta) {
    if (dto.toTableId === id) throw Errors.badRequest('SAME_TABLE', 'Choose a different table');
    await this.prisma.$transaction(async (tx) => {
      const rows = await this.lock(tx, actor, branchId, [id, dto.toTableId]);
      const from = rows.find((r) => r.id === id)!;
      const to = rows.find((r) => r.id === dto.toTableId)!;
      const session = openSessionOf(from);
      if (session.mergedIntoId) throw Errors.conflict('TABLE_MERGED', `Split table ${from.label} before transferring it`);
      if (!to.isActive || to.status !== TableStatus.AVAILABLE) {
        throw Errors.conflict('TABLE_NOT_AVAILABLE', `Table ${to.label} is not available`, { status: to.status });
      }
      await tx.tableSession.update({ where: { id: session.id }, data: { tableId: to.id } });
      await tx.restaurantTable.update({ where: { id: to.id }, data: { status: from.status, version: { increment: 1 } } });
      await tx.restaurantTable.update({ where: { id: from.id }, data: { status: TableStatus.AVAILABLE, version: { increment: 1 } } });
      await this.log(tx, actor, branchId, 'table.transferred', id, { tableId: from.id, label: from.label }, { tableId: to.id, label: to.label, sessionId: session.id }, meta);
    });
    return this.get(actor, branchId, dto.toTableId);
  }

  /** Joins other occupied tables into this one: their sessions point here and their orders move here. */
  async merge(actor: AuthPrincipal, branchId: string, id: string, dto: MergeTablesDto, meta: RequestMeta) {
    if (dto.tableIds.includes(id)) throw Errors.badRequest('SAME_TABLE', 'A table cannot be merged into itself');
    await this.prisma.$transaction(async (tx) => {
      const rows = await this.lock(tx, actor, branchId, [id, ...dto.tableIds]);
      const primaryTable = rows.find((r) => r.id === id)!;
      const primary = openSessionOf(primaryTable);
      if (primary.mergedIntoId) throw Errors.conflict('TABLE_MERGED', `Table ${primaryTable.label} is itself merged into another table`);

      const moved: string[] = [];
      for (const tid of dto.tableIds) {
        const t = rows.find((r) => r.id === tid)!;
        const s = t.sessions[0];
        if (!s) throw Errors.conflict('TABLE_NOT_OCCUPIED', `Open table ${t.label} before merging it`);
        if (s.mergedIntoId) {
          if (s.mergedIntoId === primary.id) continue; // already merged here
          throw Errors.conflict('TABLE_MERGED', `Table ${t.label} is already merged into another table`);
        }
        if (s.merged.length) throw Errors.conflict('TABLE_HAS_MERGES', `Table ${t.label} has tables merged into it; split those first`);
        await tx.tableSession.update({ where: { id: s.id }, data: { mergedIntoId: primary.id } });
        await tx.order.updateMany({ where: { tableSessionId: s.id }, data: { tableSessionId: primary.id, version: { increment: 1 } } });
        await tx.restaurantTable.update({ where: { id: tid }, data: { version: { increment: 1 } } });
        moved.push(tid);
      }
      await this.log(tx, actor, branchId, 'table.merged', id, undefined, { primarySessionId: primary.id, mergedTables: moved }, meta);
    });
    return this.get(actor, branchId, id);
  }

  /** Detaches a merged table. Orders already moved to the main table stay there. */
  async split(actor: AuthPrincipal, branchId: string, id: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const [t] = await this.lock(tx, actor, branchId, [id]);
      const s = openSessionOf(t);
      if (!s.mergedIntoId) throw Errors.conflict('TABLE_NOT_MERGED', `Table ${t.label} is not merged into another table`);
      await tx.tableSession.update({ where: { id: s.id }, data: { mergedIntoId: null } });
      await tx.restaurantTable.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.log(tx, actor, branchId, 'table.split', id, { mergedIntoSessionId: s.mergedIntoId }, { mergedIntoSessionId: null }, meta);
    });
    return this.get(actor, branchId, id);
  }

  async reserve(actor: AuthPrincipal, branchId: string, id: string, dto: ReserveTableDto, meta: RequestMeta) {
    const until = new Date(dto.until);
    if (until.getTime() <= Date.now()) throw Errors.badRequest('INVALID_RESERVATION_TIME', 'until must be in the future');
    await this.prisma.$transaction(async (tx) => {
      const [t] = await this.lock(tx, actor, branchId, [id]);
      if (!t.isActive || t.status !== TableStatus.AVAILABLE) {
        throw Errors.conflict('TABLE_NOT_AVAILABLE', `Table ${t.label} is not available`, { status: t.status });
      }
      const after = await tx.restaurantTable.update({
        where: { id },
        data: { status: TableStatus.RESERVED, reservationName: dto.name.trim(), reservationPhone: dto.phone ?? null, reservedUntil: until, version: { increment: 1 } },
      });
      await this.log(tx, actor, branchId, 'table.reserved', id, { status: t.status }, pickReservation(after), meta);
    });
    return this.get(actor, branchId, id);
  }

  async unreserve(actor: AuthPrincipal, branchId: string, id: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const [t] = await this.lock(tx, actor, branchId, [id]);
      if (t.status !== TableStatus.RESERVED) throw Errors.conflict('TABLE_NOT_RESERVED', `Table ${t.label} is not reserved`);
      await tx.restaurantTable.update({
        where: { id },
        data: { status: TableStatus.AVAILABLE, reservationName: null, reservationPhone: null, reservedUntil: null, version: { increment: 1 } },
      });
      await this.log(tx, actor, branchId, 'table.unreserved', id, pickReservation(t), { status: 'AVAILABLE' }, meta);
    });
    return this.get(actor, branchId, id);
  }

  async setOutOfService(actor: AuthPrincipal, branchId: string, id: string, dto: OutOfServiceDto, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const [t] = await this.lock(tx, actor, branchId, [id]);
      let next: TableStatus;
      if (dto.outOfService) {
        if (t.status !== TableStatus.AVAILABLE && t.status !== TableStatus.RESERVED) {
          throw Errors.conflict('TABLE_IN_USE', `Table ${t.label} is ${t.status.toLowerCase()}; close it first`);
        }
        next = TableStatus.OUT_OF_SERVICE;
      } else {
        if (t.status !== TableStatus.OUT_OF_SERVICE) throw Errors.conflict('TABLE_NOT_OUT_OF_SERVICE', `Table ${t.label} is not out of service`);
        next = TableStatus.AVAILABLE;
      }
      await tx.restaurantTable.update({
        where: { id },
        data: { status: next, reservationName: null, reservationPhone: null, reservedUntil: null, version: { increment: 1 } },
      });
      await this.log(tx, actor, branchId, dto.outOfService ? 'table.out_of_service' : 'table.back_in_service', id, { status: t.status }, { status: next }, meta);
    });
    return this.get(actor, branchId, id);
  }

  // ───────────── Internals ─────────────

  private async find(db: Tx | PrismaService, actor: AuthPrincipal, branchId: string, id: string): Promise<TableRow> {
    const t = await db.restaurantTable.findFirst({
      where: { id, branchId, organizationId: actor.organizationId, deletedAt: null },
      include: OPEN_SESSION,
    });
    if (!t) throw Errors.notFound('Table');
    return t;
  }

  /** Row-locks the tables (id order) and returns them with their open session; 404 if any is missing. */
  private async lock(tx: Tx, actor: AuthPrincipal, branchId: string, ids: string[]): Promise<TableRow[]> {
    const sorted = [...new Set(ids)].sort();
    await tx.$queryRaw`
      SELECT id FROM restaurant_tables
      WHERE id = ANY(${sorted}::uuid[]) AND branch_id = ${branchId}::uuid AND organization_id = ${actor.organizationId}::uuid
      ORDER BY id
      FOR UPDATE`;
    const rows = await tx.restaurantTable.findMany({
      where: { id: { in: sorted }, branchId, organizationId: actor.organizationId, deletedAt: null },
      include: OPEN_SESSION,
    });
    if (rows.length !== sorted.length) throw Errors.notFound('Table');
    return ids.map((id) => rows.find((r) => r.id === id)!);
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string, action: string, entityId: string | null, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record(
      { organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType: 'restaurant_table', entityId, before, after, meta },
      tx,
    );
  }
}

function openSessionOf(t: TableRow) {
  const s = t.sessions[0];
  if (!s) throw Errors.conflict('TABLE_NOT_OCCUPIED', `Table ${t.label} has no open session`);
  return s;
}

function versionConflict(current: number) {
  return Errors.conflict('CONCURRENT_UPDATE', 'This table was changed by someone else; reload and try again', { currentVersion: current });
}

function pickReservation(t: { reservationName: string | null; reservationPhone: string | null; reservedUntil: Date | null }) {
  return { reservationName: t.reservationName, reservationPhone: t.reservationPhone, reservedUntil: t.reservedUntil };
}

export function present(t: TableRow) {
  const { sessions, ...rest } = t;
  const s = sessions[0];
  return {
    ...rest,
    reservationExpired: t.status === TableStatus.RESERVED && !!t.reservedUntil && t.reservedUntil.getTime() < Date.now(),
    session: s
      ? {
          id: s.id,
          guestCount: s.guestCount,
          openedAt: s.openedAt,
          openedById: s.openedById,
          mergedIntoTableId: s.mergedInto?.tableId ?? null,
          mergedTableIds: s.merged.map((m) => m.tableId),
        }
      : null,
  };
}
