import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Expense, Prisma } from '@prisma/client';
import { requireInBranch } from '../../common/auth/branch-access';
import { dateOnly, dateRange, todayIst } from '../../common/dates';
import { Paginated } from '../../common/dto/pagination';
import { Errors } from '../../common/errors/app-error';
import type { RequestMeta } from '../../common/http/request-meta';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthPrincipal } from '../auth/principal';
import { lockOpenSession, lockSession, postCash } from '../cash/drawer';
import { sniffReceipt } from '../storage/image-validation';
import { StorageService } from '../storage/storage.service';
import {
  CreateExpenseDto,
  ExpenseCategoryDto,
  ExpenseSummaryQuery,
  ListExpenseCategoriesQuery,
  ListExpensesQuery,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/expenses.dto';

type Tx = Prisma.TransactionClient;
const Dec = Prisma.Decimal;
const ZERO = new Dec(0);

export interface UploadedReceipt {
  buffer: Buffer;
  size: number;
}

const INCLUDE = {
  category: { select: { id: true, name: true } },
  employee: { select: { id: true, fullName: true, employeeCode: true } },
} satisfies Prisma.ExpenseInclude;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ───────────── Categories ─────────────

  listCategories(actor: AuthPrincipal, q: ListExpenseCategoriesQuery) {
    return this.prisma.expenseCategory.findMany({
      where: { organizationId: actor.organizationId, isActive: q.includeInactive ? undefined : true },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(actor: AuthPrincipal, dto: ExpenseCategoryDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const name = dto.name.trim();
      await this.assertCategoryName(tx, actor.organizationId, name);
      const c = await tx.expenseCategory.create({ data: { organizationId: actor.organizationId, name } });
      await this.log(tx, actor, null, 'expense_category.created', 'expense_category', c.id, undefined, c, meta);
      return c;
    });
  }

  async updateCategory(actor: AuthPrincipal, id: string, dto: UpdateExpenseCategoryDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.expenseCategory.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw Errors.notFound('Expense category');
      const name = dto.name?.trim();
      if (name && name.toLowerCase() !== before.name.toLowerCase()) await this.assertCategoryName(tx, actor.organizationId, name);
      const after = await tx.expenseCategory.update({ where: { id }, data: { name, isActive: dto.isActive } });
      await this.log(tx, actor, null, 'expense_category.updated', 'expense_category', id, before, after, meta);
      return after;
    });
  }

  // ───────────── Expenses ─────────────

  async create(actor: AuthPrincipal, dto: CreateExpenseDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      await this.categoryOrThrow(tx, actor.organizationId, dto.categoryId);
      if (dto.employeeId) await this.employeeOrThrow(tx, actor.organizationId, dto.employeeId);
      const { amount, taxAmount } = this.amounts(dto.amount, dto.taxAmount ?? '0');
      const expenseDate = this.pastDate(dto.expenseDate);
      let cashSessionId: string | null = null;
      const id = randomUUID();
      if (dto.fromCashDrawer) {
        if (dto.paymentMethod !== 'CASH') throw Errors.badRequest('DRAWER_NEEDS_CASH', 'Only cash expenses can be paid from the cash drawer');
        const drawer = await lockOpenSession(tx, dto.branchId, actor.userId);
        if (!drawer) throw Errors.conflict('NO_OPEN_SHIFT', 'Open a cash shift to pay this from the drawer');
        await postCash(tx, drawer, { type: 'EXPENSE', amount: amount.neg(), referenceType: 'expense', referenceId: id, note: dto.description.trim(), userId: actor.userId });
        cashSessionId = drawer.id;
      }
      const e = await tx.expense.create({
        data: {
          id,
          organizationId: actor.organizationId,
          branchId: dto.branchId,
          categoryId: dto.categoryId,
          amount,
          taxAmount,
          description: dto.description.trim(),
          expenseDate,
          paymentMethod: dto.paymentMethod,
          paidTo: dto.paidTo?.trim() || null,
          employeeId: dto.employeeId ?? null,
          cashSessionId,
          createdById: actor.userId,
        },
        include: INCLUDE,
      });
      await this.log(tx, actor, dto.branchId, 'expense.created', 'expense', e.id, undefined, this.snapshot(e), meta);
      return e;
    });
  }

  async list(actor: AuthPrincipal, q: ListExpensesQuery) {
    const where: Prisma.ExpenseWhereInput = {
      organizationId: actor.organizationId,
      branchId: q.branchId,
      deletedAt: q.includeDeleted ? undefined : null,
      expenseDate: dateRange(q.from, q.to),
      categoryId: q.categoryId,
      employeeId: q.employeeId,
      paymentMethod: q.paymentMethod,
      ...(q.search ? { OR: [{ description: { contains: q.search, mode: 'insensitive' } }, { paidTo: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.expense.findMany({ where, include: INCLUDE, orderBy: [{ expenseDate: q.order }, { createdAt: q.order }], skip: q.skip, take: q.pageSize }),
      this.prisma.expense.count({ where }),
    ]);
    return new Paginated(rows, total, q);
  }

  async get(actor: AuthPrincipal, id: string) {
    const e = await this.prisma.expense.findFirst({ where: { id, organizationId: actor.organizationId }, include: INCLUDE });
    if (!e) throw Errors.notFound('Expense');
    requireInBranch(actor, e.branchId, ['expenses.read'], 'Expense');
    return e;
  }

  /** Every change to the expense, oldest first, from the audit log. */
  async history(actor: AuthPrincipal, id: string) {
    await this.get(actor, id);
    const rows = await this.prisma.auditLog.findMany({ where: { organizationId: actor.organizationId, entityType: 'expense', entityId: id }, orderBy: { id: 'asc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.actorUserId).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
    return rows.map((r) => ({ action: r.action, at: r.createdAt, by: users.find((u) => u.id === r.actorUserId) ?? null, before: r.before, after: r.after }));
  }

  /**
   * Edits keep the original in the audit log with the reason. An expense paid from a cash drawer
   * can change amount only while that shift is open (the difference goes through the drawer).
   */
  async update(actor: AuthPrincipal, id: string, dto: UpdateExpenseDto, meta: RequestMeta) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockExpense(tx, actor, id, ['expenses.update']);
      if (dto.categoryId) await this.categoryOrThrow(tx, actor.organizationId, dto.categoryId);
      if (dto.employeeId) await this.employeeOrThrow(tx, actor.organizationId, dto.employeeId);
      const { amount, taxAmount } = this.amounts(dto.amount ?? before.amount.toString(), dto.taxAmount ?? before.taxAmount.toString());
      if (before.cashSessionId) {
        if (dto.paymentMethod && dto.paymentMethod !== 'CASH') {
          throw Errors.conflict('EXPENSE_FROM_DRAWER', 'This expense was paid from a cash drawer; delete it and record it again to change how it was paid');
        }
        const diff = amount.sub(before.amount);
        if (!diff.isZero()) {
          const drawer = await lockSession(tx, actor.organizationId, before.cashSessionId);
          if (drawer?.status !== 'OPEN') throw Errors.conflict('SHIFT_CLOSED', 'The cash shift this was paid from is closed; record the difference as a new expense');
          await postCash(tx, drawer, { type: 'EXPENSE', amount: diff.neg(), referenceType: 'expense', referenceId: id, note: `Corrected: ${dto.reason.trim()}`, userId: actor.userId });
        }
      }
      const after = await tx.expense.update({
        where: { id },
        data: {
          categoryId: dto.categoryId,
          amount,
          taxAmount,
          description: dto.description?.trim(),
          expenseDate: dto.expenseDate ? this.pastDate(dto.expenseDate) : undefined,
          paymentMethod: dto.paymentMethod,
          paidTo: dto.paidTo === undefined ? undefined : dto.paidTo.trim() || null,
          employeeId: dto.employeeId,
          updatedById: actor.userId,
        },
        include: INCLUDE,
      });
      await this.log(tx, actor, after.branchId, 'expense.updated', 'expense', id, this.snapshot(before), { ...this.snapshot(after), reason: dto.reason.trim() }, meta);
      return after;
    });
  }

  /** Soft delete with a reason; cash paid from a still-open drawer goes back into it. */
  async remove(actor: AuthPrincipal, id: string, reason: string, meta: RequestMeta) {
    await this.prisma.$transaction(async (tx) => {
      const e = await this.lockExpense(tx, actor, id, ['expenses.delete']);
      if (e.cashSessionId) {
        const drawer = await lockSession(tx, actor.organizationId, e.cashSessionId);
        if (drawer?.status !== 'OPEN') throw Errors.conflict('SHIFT_CLOSED', 'The cash shift this was paid from is closed, so the cash cannot go back into it');
        await postCash(tx, drawer, { type: 'EXPENSE', amount: e.amount, referenceType: 'expense', referenceId: id, note: `Deleted: ${reason.trim()}`, userId: actor.userId });
      }
      await tx.expense.update({ where: { id }, data: { deletedAt: new Date(), deletedById: actor.userId, deleteReason: reason.trim() } });
      await this.log(tx, actor, e.branchId, 'expense.deleted', 'expense', id, this.snapshot(e), { reason: reason.trim() }, meta);
    });
  }

  async uploadReceipt(actor: AuthPrincipal, id: string, file: UploadedReceipt | undefined, meta: RequestMeta) {
    const e = await this.get(actor, id);
    if (e.deletedAt) throw Errors.conflict('EXPENSE_DELETED', 'This expense is deleted');
    if (e.createdById !== actor.userId) requireInBranch(actor, e.branchId, ['expenses.update'], 'Expense');
    if (!file?.buffer?.length) throw Errors.badRequest('FILE_REQUIRED', 'Attach the receipt as multipart field "receipt"');
    const type = sniffReceipt(file.buffer);
    if (!type) throw Errors.unprocessable('UNSUPPORTED_FILE', 'Receipts must be JPEG, PNG, WebP or PDF');
    // Random, unguessable key: receipts are financial documents.
    const receiptUrl = await this.storage.put(`${actor.organizationId}/receipts/${randomUUID()}.${type.ext}`, file.buffer, type.contentType);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.expense.update({ where: { id }, data: { receiptUrl, updatedById: actor.userId }, include: INCLUDE });
      await this.log(tx, actor, e.branchId, 'expense.receipt_uploaded', 'expense', id, { receiptUrl: e.receiptUrl }, { receiptUrl, bytes: file.buffer.length, contentType: type.contentType }, meta);
      return after;
    });
  }

  /** Totals for a period by category and by payment method (deleted expenses excluded). */
  async summary(actor: AuthPrincipal, q: ExpenseSummaryQuery) {
    const where: Prisma.ExpenseWhereInput = { organizationId: actor.organizationId, branchId: q.branchId, deletedAt: null, expenseDate: dateRange(q.from, q.to) };
    const [byCat, byMethod, total] = await Promise.all([
      this.prisma.expense.groupBy({ by: ['categoryId'], where, _sum: { amount: true, taxAmount: true }, _count: true }),
      this.prisma.expense.groupBy({ by: ['paymentMethod'], where, _sum: { amount: true }, _count: true }),
      this.prisma.expense.aggregate({ where, _sum: { amount: true, taxAmount: true }, _count: true }),
    ]);
    const cats = await this.prisma.expenseCategory.findMany({ where: { id: { in: byCat.map((c) => c.categoryId) } }, select: { id: true, name: true } });
    return {
      from: q.from,
      to: q.to,
      count: total._count,
      total: total._sum.amount ?? ZERO,
      taxTotal: total._sum.taxAmount ?? ZERO,
      byCategory: byCat
        .map((c) => ({ categoryId: c.categoryId, name: cats.find((x) => x.id === c.categoryId)?.name ?? '', count: c._count, amount: c._sum.amount ?? ZERO, taxAmount: c._sum.taxAmount ?? ZERO }))
        .sort((a, b) => b.amount.cmp(a.amount) || a.name.localeCompare(b.name)),
      byPaymentMethod: byMethod.map((m) => ({ method: m.paymentMethod, count: m._count, amount: m._sum.amount ?? ZERO })).sort((a, b) => a.method.localeCompare(b.method)),
    };
  }

  // ───────────── Helpers ─────────────

  private amounts(amountStr: string, taxStr: string) {
    const amount = new Dec(amountStr);
    const taxAmount = new Dec(taxStr);
    if (amount.lte(0)) throw Errors.badRequest('INVALID_AMOUNT', 'amount must be greater than 0');
    if (taxAmount.gt(amount)) throw Errors.badRequest('INVALID_TAX', 'taxAmount cannot be more than the amount');
    return { amount, taxAmount };
  }

  private pastDate(s: string) {
    const d = dateOnly(s);
    if (d > todayIst()) throw Errors.badRequest('FUTURE_DATE', 'An expense cannot be dated in the future');
    return d;
  }

  private snapshot(e: Expense) {
    return {
      categoryId: e.categoryId,
      amount: e.amount,
      taxAmount: e.taxAmount,
      description: e.description,
      expenseDate: e.expenseDate.toISOString().slice(0, 10),
      paymentMethod: e.paymentMethod,
      paidTo: e.paidTo,
      employeeId: e.employeeId,
      cashSessionId: e.cashSessionId,
    };
  }

  private async lockExpense(tx: Tx, actor: AuthPrincipal, id: string, permissions: string[]) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM expenses WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
    if (!rows.length) throw Errors.notFound('Expense');
    const e = await tx.expense.findUniqueOrThrow({ where: { id } });
    requireInBranch(actor, e.branchId, permissions, 'Expense');
    if (e.deletedAt) throw Errors.conflict('EXPENSE_DELETED', 'This expense is deleted');
    return e;
  }

  private async categoryOrThrow(tx: Tx, organizationId: string, id: string) {
    const c = await tx.expenseCategory.findFirst({ where: { id, organizationId } });
    if (!c) throw Errors.badRequest('INVALID_CATEGORY', 'Unknown expense category');
    if (!c.isActive) throw Errors.unprocessable('CATEGORY_INACTIVE', `${c.name} is no longer in use`);
    return c;
  }

  private async employeeOrThrow(tx: Tx, organizationId: string, id: string) {
    const e = await tx.employee.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!e) throw Errors.badRequest('INVALID_EMPLOYEE', 'Unknown employee');
    return e;
  }

  private async assertCategoryName(tx: Tx, organizationId: string, name: string) {
    const clash = await tx.expenseCategory.findFirst({ where: { organizationId, name: { equals: name, mode: 'insensitive' } } });
    if (clash) throw Errors.conflict('DUPLICATE_NAME', `A category named "${clash.name}" already exists`);
  }

  private log(tx: Tx, actor: AuthPrincipal, branchId: string | null, action: string, entityType: string, entityId: string, before: unknown, after: unknown, meta: RequestMeta) {
    return this.audit.record({ organizationId: actor.organizationId, branchId, actorUserId: actor.userId, action, entityType, entityId, before, after, meta }, tx);
  }
}
