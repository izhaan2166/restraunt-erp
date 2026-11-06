import { Prisma } from '@prisma/client';
import { TestContext, createTestApp } from './helpers/app';
import { OrgFixture, createOrg } from './helpers/fixtures';

/**
 * The database is the last line of defence for financial and stock integrity. These tests write
 * directly through Prisma (bypassing services) and expect PostgreSQL itself to refuse bad data.
 */
describe('Database integrity rules (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let actor: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Integrity');
    actor = fx.users.cashierA.id;
  });
  afterAll(() => ctx.close());

  async function makeOrder(overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
    return ctx.prisma.order.create({
      data: {
        organizationId: fx.orgId,
        branchId: fx.branchA,
        orderNumber: `T-${Math.random().toString(36).slice(2, 10)}`,
        orderType: 'TAKEAWAY',
        createdById: actor,
        ...overrides,
      },
    });
  }

  async function makeInvoice(orderId: string) {
    const seq = await ctx.prisma.documentSequence.create({
      data: {
        organizationId: fx.orgId,
        branchId: fx.branchA,
        type: 'INVOICE',
        prefix: `INV${Math.random().toString(36).slice(2, 6)}`,
        period: '2026-27',
      },
    });
    return ctx.prisma.invoice.create({
      data: {
        organizationId: fx.orgId,
        branchId: fx.branchA,
        orderId,
        sequenceId: seq.id,
        invoiceNumber: `${seq.prefix}/2026-27/000001`,
        supplyType: 'INTRA_STATE',
        placeOfSupply: '29',
        sellerDetails: { legalName: 'Integrity Pvt Ltd', gstin: '29AABCD1234E1Z5' },
        subtotal: '1000.00',
        discountTotal: '100.00',
        taxableAmount: '900.00',
        cgstAmount: '22.50',
        sgstAmount: '22.50',
        igstAmount: '0',
        taxTotal: '45.00',
        roundOff: '0',
        grandTotal: '945.00',
        createdById: actor,
      },
    });
  }

  it('stores money as exact decimals', async () => {
    const order = await makeOrder({ subtotal: '0.10', discountTotal: '0', grandTotal: '0.30', taxableAmount: '0.20' });
    const back = await ctx.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(back.grandTotal.toString()).toBe('0.3');
    expect(back.subtotal.plus(back.taxableAmount).toString()).toBe('0.3');
  });

  it('rejects negative totals and discounts larger than the subtotal', async () => {
    await expect(makeOrder({ grandTotal: '-1' })).rejects.toThrow(/orders_amounts_valid/);
    await expect(makeOrder({ subtotal: '100', discountTotal: '150' })).rejects.toThrow(/orders_amounts_valid/);
  });

  it('requires a reason and an actor to cancel an order', async () => {
    const order = await makeOrder();
    await expect(ctx.prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } })).rejects.toThrow(
      /orders_cancel_reason_required/,
    );
    await ctx.prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', cancelReason: 'Customer left', cancelledById: actor, cancelledAt: new Date() },
    });
  });

  it('requires a table for dine-in orders', async () => {
    await expect(makeOrder({ orderType: 'DINE_IN' })).rejects.toThrow(/orders_dine_in_needs_table/);
  });

  it('enforces unique order numbers per branch', async () => {
    const o = await makeOrder();
    await expect(makeOrder({ orderNumber: o.orderNumber })).rejects.toThrow(/Unique constraint/);
  });

  it('refuses an order whose branch belongs to another organization', async () => {
    const other = await createOrg(ctx.prisma, 'Other');
    await expect(makeOrder({ branchId: other.branchA })).rejects.toThrow(/Foreign key constraint/);
  });

  describe('invoices', () => {
    it('checks that tax components add up and match the supply type', async () => {
      const order = await makeOrder();
      const inv = await makeInvoice(order.id);
      await expect(
        ctx.prisma.invoice.update({ where: { id: inv.id }, data: { igstAmount: '45.00' } }),
      ).rejects.toThrow(/invoices_amounts_valid/);
    });

    it('cannot be paid beyond the grand total', async () => {
      const order = await makeOrder();
      const inv = await makeInvoice(order.id);
      await expect(ctx.prisma.invoice.update({ where: { id: inv.id }, data: { paidAmount: '945.01' } })).rejects.toThrow(
        /invoices_amounts_valid/,
      );
    });

    it('allows only one active invoice per order', async () => {
      const order = await makeOrder();
      await makeInvoice(order.id);
      await expect(makeInvoice(order.id)).rejects.toThrow(/Unique constraint/);
    });

    it('are frozen once finalized: amounts, items and deletion are refused, payment progress is allowed', async () => {
      const order = await makeOrder();
      const inv = await makeInvoice(order.id);
      await ctx.prisma.invoiceItem.create({
        data: {
          invoiceId: inv.id,
          description: 'Paneer Tikka',
          hsnSac: '996331',
          quantity: '2',
          unitPrice: '500',
          discount: '100',
          taxableAmount: '900',
          cgstRate: '2.5',
          cgstAmount: '22.5',
          sgstRate: '2.5',
          sgstAmount: '22.5',
          lineTotal: '945',
        },
      });
      await ctx.prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'FINALIZED', finalizedAt: new Date(), finalizedById: actor },
      });

      await expect(ctx.prisma.invoice.update({ where: { id: inv.id }, data: { grandTotal: '1.00' } })).rejects.toThrow(
        /cannot be modified/,
      );
      await expect(ctx.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'DRAFT' } })).rejects.toThrow(
        /cannot be modified/,
      );
      await expect(ctx.prisma.invoiceItem.updateMany({ where: { invoiceId: inv.id }, data: { lineTotal: '1' } })).rejects.toThrow(
        /cannot be changed/,
      );
      await expect(ctx.prisma.invoice.delete({ where: { id: inv.id } })).rejects.toThrow(/cannot be deleted/);

      const paid = await ctx.prisma.invoice.update({
        where: { id: inv.id },
        data: { paidAmount: '945.00', paymentStatus: 'PAID' },
      });
      expect(paid.paymentStatus).toBe('PAID');
      const untouched = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      expect(untouched.grandTotal.toFixed(2)).toBe('945.00');
    });
  });

  describe('stock ledger', () => {
    it('is append-only, sign-checked, and deduplicates the same business event', async () => {
      const unit = await ctx.prisma.unit.findUniqueOrThrow({ where: { code: 'g' } });
      const ing = await ctx.prisma.ingredient.create({
        data: { organizationId: fx.orgId, name: `Chicken ${Date.now()}`, baseUnitId: unit.id },
      });
      const base = {
        organizationId: fx.orgId,
        branchId: fx.branchA,
        ingredientId: ing.id,
        referenceType: 'order_item',
        referenceId: '00000000-0000-4000-8000-000000000001',
        createdById: actor,
      };
      const mv = await ctx.prisma.stockMovement.create({
        data: { ...base, type: 'SALE_CONSUMPTION', quantity: '-150', balanceAfter: '850', dedupeKey: `oi:${ing.id}:consume` },
      });
      await expect(
        ctx.prisma.stockMovement.create({
          data: { ...base, type: 'SALE_CONSUMPTION', quantity: '-150', balanceAfter: '700', dedupeKey: `oi:${ing.id}:consume` },
        }),
      ).rejects.toThrow(/Unique constraint/);
      await expect(
        ctx.prisma.stockMovement.create({
          data: { ...base, type: 'SALE_CONSUMPTION', quantity: '150', balanceAfter: '1000', dedupeKey: `oi:${ing.id}:x` },
        }),
      ).rejects.toThrow(/stock_movements_sign_matches_type/);
      await expect(ctx.prisma.stockMovement.update({ where: { id: mv.id }, data: { quantity: '-1' } })).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('tax rates', () => {
    it('must split evenly into CGST + SGST and equal IGST', async () => {
      await expect(
        ctx.prisma.taxRate.create({
          data: { organizationId: fx.orgId, name: 'Broken', rate: '5', cgstRate: '2', sgstRate: '2', igstRate: '5' },
        }),
      ).rejects.toThrow(/tax_rates_valid/);
    });
  });

  describe('cash sessions', () => {
    it('allow one open shift per cashier and require a full reconciliation to close', async () => {
      const open = await ctx.prisma.cashSession.create({
        data: { organizationId: fx.orgId, branchId: fx.branchA, userId: actor, openingBalance: '2000' },
      });
      await expect(
        ctx.prisma.cashSession.create({
          data: { organizationId: fx.orgId, branchId: fx.branchA, userId: actor, openingBalance: '0' },
        }),
      ).rejects.toThrow(/Unique constraint/);
      await expect(
        ctx.prisma.cashSession.update({ where: { id: open.id }, data: { status: 'CLOSED', closedAt: new Date() } }),
      ).rejects.toThrow(/cash_sessions_valid/);
      const closed = await ctx.prisma.cashSession.update({
        where: { id: open.id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closedById: actor,
          expectedCash: '5400.00',
          actualCash: '5350.00',
          discrepancy: '-50.00',
        },
      });
      expect(closed.discrepancy!.toFixed(2)).toBe('-50.00');
    });
  });

  it('rejects malformed GSTINs', async () => {
    await expect(
      ctx.prisma.organization.update({ where: { id: fx.orgId }, data: { gstin: '29ABC' } }),
    ).rejects.toThrow(/organizations_gstin_format/);
  });
});
