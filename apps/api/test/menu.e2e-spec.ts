import { readFile } from 'node:fs/promises';
import { API, TestContext, createTestApp } from './helpers/app';
import { OrgFixture, addUserWithRole, bearer, createOrg, tokenFor } from './helpers/fixtures';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-but-correctly-headed-png')]);

describe('Menu (e2e)', () => {
  let ctx: TestContext;
  let fx: OrgFixture;
  let other: OrgFixture;
  const tok: Record<string, string> = {};
  let categoryId: string;
  let taxRateId: string;
  let groupId: string;
  let product: { id: string; variants: { id: string; name: string; isDefault: boolean }[] };

  const half = () => product.variants.find((v) => v.name === 'Half')!.id;
  const full = () => product.variants.find((v) => v.name === 'Full')!.id;
  const menuItem = async (branchId: string, token = tok.owner) => {
    const res = await ctx.http().get(`${API}/menu`).query({ branchId }).set(bearer(token)).expect(200);
    return res.body.data.products.find((p: { id: string }) => p.id === product.id);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    fx = await createOrg(ctx.prisma, 'Menu');
    other = await createOrg(ctx.prisma, 'MenuOther');
    for (const h of ['owner', 'managerA', 'managerB', 'waiterA', 'kitchenA', 'cashierA']) tok[h] = await tokenFor(ctx, fx, h);
    tok.otherOwner = await tokenFor(ctx, other, 'owner');

    // A menu editor who may edit items but not prices.
    const role = await ctx
      .http()
      .post(`${API}/roles`)
      .set(bearer(tok.owner))
      .send({ key: 'MENU_EDITOR', name: 'Menu editor', permissions: ['menu.read', 'menu.manage'] })
      .expect(201);
    tok.editor = await addUserWithRole(ctx, fx, 'editor', role.body.data.id);
  });
  afterAll(() => ctx.close());

  describe('setup: tax rates, categories, add-ons', () => {
    it('creates a GST rate with CGST/SGST split derived server-side', async () => {
      const res = await ctx.http().post(`${API}/tax-rates`).set(bearer(tok.owner)).send({ name: 'GST 5%', rate: '5' }).expect(201);
      expect(res.body.data).toEqual(expect.objectContaining({ rate: '5', cgstRate: '2.5', sgstRate: '2.5', igstRate: '5' }));
      taxRateId = res.body.data.id;
    });

    it('tax rates are immutable once created and only managed organization-wide', async () => {
      await ctx.http().patch(`${API}/tax-rates/${taxRateId}`).set(bearer(tok.owner)).send({ rate: '12' }).expect(400);
      await ctx.http().post(`${API}/tax-rates`).set(bearer(tok.managerA)).send({ name: 'GST 12%', rate: '12' }).expect(403);
      const odd = await ctx.http().post(`${API}/tax-rates`).set(bearer(tok.owner)).send({ name: 'Odd', rate: '5.001' }).expect(400);
      expect(odd.body.error.code).toBeDefined();
      const list = await ctx.http().get(`${API}/tax-rates`).set(bearer(tok.cashierA)).expect(200);
      expect(list.body.data.map((r: { id: string }) => r.id)).toContain(taxRateId);
    });

    it('kitchen stations are managed per branch', async () => {
      const res = await ctx.http().post(`${API}/branches/${fx.branchA}/kitchen-stations`).set(bearer(tok.managerA)).send({ code: 'TANDOOR', name: 'Tandoor' }).expect(201);
      expect(res.body.data.branchId).toBe(fx.branchA);
      await ctx.http().post(`${API}/branches/${fx.branchB}/kitchen-stations`).set(bearer(tok.managerA)).send({ code: 'TANDOOR', name: 'Tandoor' }).expect(403);
      await ctx.http().post(`${API}/branches/${fx.branchA}/kitchen-stations`).set(bearer(tok.managerA)).send({ code: 'TANDOOR', name: 'Again' }).expect(409);
      const list = await ctx.http().get(`${API}/branches/${fx.branchA}/kitchen-stations`).set(bearer(tok.kitchenA)).expect(200);
      expect(list.body.data.map((k: { code: string }) => k.code)).toContain('TANDOOR');
    });

    it('creates a category; waiters and branch managers cannot', async () => {
      const res = await ctx.http().post(`${API}/menu/categories`).set(bearer(tok.owner)).send({ name: 'Starters', sortOrder: 1 }).expect(201);
      categoryId = res.body.data.id;
      await ctx.http().post(`${API}/menu/categories`).set(bearer(tok.waiterA)).send({ name: 'X' }).expect(403);
      await ctx.http().post(`${API}/menu/categories`).set(bearer(tok.managerA)).send({ name: 'X' }).expect(403);
      const list = await ctx.http().get(`${API}/menu/categories`).set(bearer(tok.waiterA)).expect(200);
      expect(list.body.data.map((c: { id: string }) => c.id)).toContain(categoryId);
    });

    it('creates an add-on group with min/max rules', async () => {
      await ctx
        .http()
        .post(`${API}/menu/modifier-groups`)
        .set(bearer(tok.owner))
        .send({ name: 'Bad', minSelect: 3, maxSelect: 1 })
        .expect(400);
      const res = await ctx
        .http()
        .post(`${API}/menu/modifier-groups`)
        .set(bearer(tok.owner))
        .send({ name: 'Add-ons', minSelect: 0, maxSelect: 2, modifiers: [{ name: 'Extra cheese', price: '40.00' }, { name: 'Mint dip', price: '15' }] })
        .expect(201);
      groupId = res.body.data.id;
      expect(res.body.data.modifiers.map((m: { price: string }) => m.price).sort()).toEqual(['15', '40']);
    });
  });

  describe('products and variants', () => {
    it('creates a product with variants, add-ons and a tax rate; first variant becomes default', async () => {
      const res = await ctx
        .http()
        .post(`${API}/menu/products`)
        .set(bearer(tok.owner))
        .send({
          categoryId,
          sku: 'str-pnr-tikka',
          name: 'Paneer Tikka',
          basePrice: '280.00',
          taxRateId,
          hsnSac: '996331',
          stationCode: 'MAIN',
          variants: [
            { name: 'Half', price: '180.00' },
            { name: 'Full', price: '320.00' },
          ],
          modifierGroupIds: [groupId],
        })
        .expect(201);
      product = res.body.data;
      expect(res.body.data.sku).toBe('STR-PNR-TIKKA');
      expect(res.body.data.basePrice).toBe('280');
      expect(product.variants.find((v) => v.isDefault)!.name).toBe('Half');
      expect(res.body.data.modifierGroups[0].group.id).toBe(groupId);
    });

    it('rejects bad money, duplicate SKUs, foreign categories and wrong roles', async () => {
      const base = { categoryId, sku: 'X1', name: 'X', basePrice: '10.00' };
      await ctx.http().post(`${API}/menu/products`).set(bearer(tok.owner)).send({ ...base, basePrice: '12.345' }).expect(400);
      await ctx.http().post(`${API}/menu/products`).set(bearer(tok.owner)).send({ ...base, basePrice: '-1' }).expect(400);
      const dup = await ctx.http().post(`${API}/menu/products`).set(bearer(tok.owner)).send({ ...base, sku: 'STR-PNR-TIKKA' }).expect(409);
      expect(dup.body.error.code).toBe('UNIQUE_VIOLATION');
      const otherCat = await ctx.http().post(`${API}/menu/categories`).set(bearer(tok.otherOwner)).send({ name: 'Theirs' }).expect(201);
      const bad = await ctx.http().post(`${API}/menu/products`).set(bearer(tok.owner)).send({ ...base, categoryId: otherCat.body.data.id }).expect(400);
      expect(bad.body.error.code).toBe('INVALID_CATEGORY');
      await ctx.http().post(`${API}/menu/products`).set(bearer(tok.waiterA)).send(base).expect(403);
      // Creating a product sets prices, so the price permission is needed too.
      await ctx.http().post(`${API}/menu/products`).set(bearer(tok.editor)).send(base).expect(403);
    });

    it('menu editors can edit details but not prices', async () => {
      await ctx.http().patch(`${API}/menu/products/${product.id}`).set(bearer(tok.editor)).send({ description: 'Smoky, char-grilled' }).expect(200);
      const price = await ctx.http().patch(`${API}/menu/products/${product.id}`).set(bearer(tok.editor)).send({ basePrice: '1.00' }).expect(403);
      expect(price.body.error.details.missing).toEqual(['menu.price.update']);
      await ctx.http().patch(`${API}/menu/products/${product.id}/variants/${full()}`).set(bearer(tok.editor)).send({ price: '1.00' }).expect(403);
      await ctx.http().post(`${API}/menu/products/${product.id}/variants`).set(bearer(tok.editor)).send({ name: 'Mini', price: '90.00' }).expect(403);
      const group = await ctx.http().get(`${API}/menu/modifier-groups/${groupId}`).set(bearer(tok.editor)).expect(200);
      await ctx
        .http()
        .patch(`${API}/menu/modifier-groups/${groupId}/modifiers/${group.body.data.modifiers[0].id}`)
        .set(bearer(tok.editor))
        .send({ price: '0' })
        .expect(403);
      // Sending the unchanged price is not a price change.
      await ctx.http().patch(`${API}/menu/products/${product.id}`).set(bearer(tok.editor)).send({ basePrice: '280.00', name: 'Paneer Tikka' }).expect(200);
    });

    it('owner price changes are audited with before/after', async () => {
      await ctx.http().patch(`${API}/menu/products/${product.id}/variants/${full()}`).set(bearer(tok.owner)).send({ price: '330.00' }).expect(200);
      const log = await ctx.prisma.auditLog.findFirst({
        where: { organizationId: fx.orgId, action: 'product_variant.price_changed', entityId: full() },
      });
      expect(log).toBeTruthy();
      expect((log!.before as { price: string }).price).toBe('320');
      expect((log!.after as { price: string }).price).toBe('330');
    });

    it('moving the default to another variant keeps exactly one default', async () => {
      const res = await ctx.http().patch(`${API}/menu/products/${product.id}/variants/${full()}`).set(bearer(tok.owner)).send({ isDefault: true }).expect(200);
      const defaults = res.body.data.variants.filter((v: { isDefault: boolean }) => v.isDefault);
      expect(defaults.map((v: { id: string }) => v.id)).toEqual([full()]);
      // Deactivating the default promotes another active variant.
      const off = await ctx.http().patch(`${API}/menu/products/${product.id}/variants/${full()}`).set(bearer(tok.owner)).send({ isActive: false }).expect(200);
      expect(off.body.data.variants.filter((v: { isDefault: boolean }) => v.isDefault).map((v: { id: string }) => v.id)).toEqual([half()]);
      await ctx.http().patch(`${API}/menu/products/${product.id}/variants/${full()}`).set(bearer(tok.owner)).send({ isActive: true }).expect(200);
    });

    it('lists and searches products with pagination', async () => {
      const res = await ctx.http().get(`${API}/menu/products`).query({ search: 'paneer', pageSize: 5 }).set(bearer(tok.waiterA)).expect(200);
      expect(res.body.meta).toEqual(expect.objectContaining({ page: 1, pageSize: 5, total: 1 }));
      expect(res.body.data[0].id).toBe(product.id);
    });
  });

  describe('branch pricing and availability', () => {
    it('a branch price override only changes that branch', async () => {
      await ctx
        .http()
        .put(`${API}/menu/products/${product.id}/branch-prices`)
        .set(bearer(tok.owner))
        .send({ branchId: fx.branchB, overrides: [{ variantId: full(), price: '350.00' }] })
        .expect(200);
      const b = await menuItem(fx.branchB);
      const a = await menuItem(fx.branchA);
      expect(b.variants.find((v: { id: string }) => v.id === full()).price).toBe('350');
      expect(a.variants.find((v: { id: string }) => v.id === full()).price).toBe('330');
      expect(b.taxRate.rate).toBe('5');
    });

    it('branch prices need menu.price.update in that branch', async () => {
      // Managers hold menu.availability.update but not menu.price.update by default.
      const denied = await ctx
        .http()
        .put(`${API}/menu/products/${product.id}/branch-prices`)
        .set(bearer(tok.managerA))
        .send({ branchId: fx.branchA, overrides: [{ variantId: half(), price: '175.00' }] })
        .expect(403);
      expect(denied.body.error.details.missing).toEqual(['menu.price.update']);

      const role = await ctx
        .http()
        .post(`${API}/roles`)
        .set(bearer(tok.owner))
        .send({ key: 'BRANCH_PRICER', name: 'Branch pricer', permissions: ['menu.read', 'menu.availability.update', 'menu.price.update'] })
        .expect(201);
      const pricerA = await addUserWithRole(ctx, fx, 'pricerA', role.body.data.id, fx.branchA);
      await ctx
        .http()
        .put(`${API}/menu/products/${product.id}/branch-prices`)
        .set(bearer(pricerA))
        .send({ branchId: fx.branchB, overrides: [{ variantId: full(), price: '1.00' }] })
        .expect(403);
      await ctx
        .http()
        .put(`${API}/menu/products/${product.id}/branch-prices`)
        .set(bearer(pricerA))
        .send({ branchId: fx.branchA, overrides: [{ variantId: half(), price: '175.00' }] })
        .expect(200);
      expect((await menuItem(fx.branchA)).variants.find((v: { id: string }) => v.id === half()).price).toBe('175');
      // Prices of products are organization-wide, so a branch-level price right cannot change them.
      await ctx.http().patch(`${API}/menu/products/${product.id}`).set(bearer(pricerA)).send({ basePrice: '1.00' }).expect(403);
    });

    it('kitchen staff can 86 an item in their branch but cannot change prices or other branches', async () => {
      await ctx.http().patch(`${API}/menu/products/${product.id}/availability`).set(bearer(tok.kitchenA)).send({ branchId: fx.branchA, isAvailable: false }).expect(200);
      const a = await menuItem(fx.branchA, tok.kitchenA);
      expect(a.isAvailable).toBe(false);
      expect(a.variants.every((v: { isAvailable: boolean }) => !v.isAvailable)).toBe(true);
      // Branch A's price override survived the availability change.
      expect(a.variants.find((v: { id: string }) => v.id === half()).price).toBe('175');
      expect((await menuItem(fx.branchB)).isAvailable).toBe(true);

      await ctx.http().patch(`${API}/menu/products/${product.id}/availability`).set(bearer(tok.kitchenA)).send({ branchId: fx.branchB, isAvailable: false }).expect(403);
      await ctx.http().patch(`${API}/menu/products/${product.id}/availability`).set(bearer(tok.kitchenA)).send({ isAvailable: false }).expect(403);
      await ctx
        .http()
        .put(`${API}/menu/products/${product.id}/branch-prices`)
        .set(bearer(tok.kitchenA))
        .send({ branchId: fx.branchA, overrides: [{ variantId: half(), price: '1.00' }] })
        .expect(403);
      await ctx.http().patch(`${API}/menu/products/${product.id}/availability`).set(bearer(tok.kitchenA)).send({ branchId: fx.branchA, isAvailable: true }).expect(200);
      expect((await menuItem(fx.branchA)).isAvailable).toBe(true);
    });

    it('organization-wide unavailability applies to every branch', async () => {
      await ctx.http().patch(`${API}/menu/products/${product.id}/availability`).set(bearer(tok.owner)).send({ isAvailable: false }).expect(200);
      expect((await menuItem(fx.branchA)).isAvailable).toBe(false);
      expect((await menuItem(fx.branchB)).isAvailable).toBe(false);
      await ctx.http().patch(`${API}/menu/products/${product.id}/availability`).set(bearer(tok.owner)).send({ isAvailable: true }).expect(200);
    });

    it('rejects variants from another product and duplicate overrides', async () => {
      const res = await ctx
        .http()
        .put(`${API}/menu/products/${product.id}/branch-prices`)
        .set(bearer(tok.owner))
        .send({ branchId: fx.branchB, overrides: [{ variantId: '00000000-0000-4000-8000-000000000000', price: '1.00' }] })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_VARIANT');
      await ctx
        .http()
        .put(`${API}/menu/products/${product.id}/branch-prices`)
        .set(bearer(tok.owner))
        .send({ branchId: fx.branchB, overrides: [{ variantId: full(), price: '1' }, { variantId: full(), price: '2' }] })
        .expect(400);
    });

    it('the POS menu includes add-ons and the branch tax pricing mode', async () => {
      const res = await ctx.http().get(`${API}/menu`).query({ branchId: fx.branchA }).set(bearer(tok.waiterA)).expect(200);
      expect(res.body.data.taxPricingMode).toBe('EXCLUSIVE');
      const item = res.body.data.products.find((p: { id: string }) => p.id === product.id);
      expect(item.modifierGroups[0]).toEqual(expect.objectContaining({ id: groupId, minSelect: 0, maxSelect: 2 }));
      // Waiters in branch A cannot read branch B's menu.
      await ctx.http().get(`${API}/menu`).query({ branchId: fx.branchB }).set(bearer(tok.waiterA)).expect(403);
    });
  });

  describe('combos and deletion', () => {
    let comboId: string;

    it('creates a combo of other products; nesting and self-reference are rejected', async () => {
      const res = await ctx
        .http()
        .post(`${API}/menu/products`)
        .set(bearer(tok.owner))
        .send({
          categoryId,
          sku: 'CMB-PARTY',
          name: 'Party Combo',
          basePrice: '499.00',
          isCombo: true,
          comboItems: [{ productId: product.id, variantId: half(), quantity: '2' }],
        })
        .expect(201);
      comboId = res.body.data.id;
      expect(res.body.data.comboItems).toHaveLength(1);
      expect(res.body.data.comboItems[0].quantity).toBe('2');

      const nested = await ctx
        .http()
        .post(`${API}/menu/products`)
        .set(bearer(tok.owner))
        .send({ categoryId, sku: 'CMB-NEST', name: 'Nest', basePrice: '1', isCombo: true, comboItems: [{ productId: comboId, quantity: '1' }] })
        .expect(400);
      expect(nested.body.error.code).toBe('INVALID_COMBO_ITEM');
      await ctx.http().put(`${API}/menu/products/${comboId}/combo-items`).set(bearer(tok.owner)).send({ items: [{ productId: comboId, quantity: '1' }] }).expect(400);
      await ctx.http().put(`${API}/menu/products/${product.id}/combo-items`).set(bearer(tok.owner)).send({ items: [] }).expect(400);
    });

    it('a product used in a combo cannot be deleted; a category with products cannot be deleted', async () => {
      const res = await ctx.http().delete(`${API}/menu/products/${product.id}`).set(bearer(tok.owner)).expect(409);
      expect(res.body.error.code).toBe('PRODUCT_IN_COMBO');
      const cat = await ctx.http().delete(`${API}/menu/categories/${categoryId}`).set(bearer(tok.owner)).expect(409);
      expect(cat.body.error.code).toBe('CATEGORY_NOT_EMPTY');
    });

    it('deleting is a soft delete: hidden from the API, kept in the database', async () => {
      await ctx.http().delete(`${API}/menu/products/${comboId}`).set(bearer(tok.owner)).expect(204);
      await ctx.http().get(`${API}/menu/products/${comboId}`).set(bearer(tok.owner)).expect(404);
      const row = await ctx.prisma.product.findUnique({ where: { id: comboId } });
      expect(row?.deletedAt).toBeTruthy();
      const menu = await ctx.http().get(`${API}/menu`).query({ branchId: fx.branchA }).set(bearer(tok.owner)).expect(200);
      expect(menu.body.data.products.map((p: { id: string }) => p.id)).not.toContain(comboId);
    });
  });

  describe('product images', () => {
    it('accepts a real PNG and serves it', async () => {
      const res = await ctx.http().post(`${API}/menu/products/${product.id}/image`).set(bearer(tok.owner)).attach('image', PNG, 'photo.png').expect(201);
      const url: string = res.body.data.imageUrl;
      expect(url).toMatch(new RegExp(`^/uploads/${fx.orgId}/products/[0-9a-f-]{36}\\.png$`));
      const file = await ctx.http().get(url).expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(await readFile(`${process.env.UPLOAD_DIR}${url.slice('/uploads'.length)}`), PNG)).toBe(0);
    });

    it('rejects non-images even when named .png, oversize files and missing files', async () => {
      const fake = await ctx
        .http()
        .post(`${API}/menu/products/${product.id}/image`)
        .set(bearer(tok.owner))
        .attach('image', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'x.png', contentType: 'image/png' })
        .expect(422);
      expect(fake.body.error.code).toBe('UNSUPPORTED_IMAGE');
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      await ctx.http().post(`${API}/menu/products/${product.id}/image`).set(bearer(tok.owner)).attach('image', big, 'big.png').expect(413);
      await ctx.http().post(`${API}/menu/products/${product.id}/image`).set(bearer(tok.owner)).field('note', 'x').expect(400);
      await ctx.http().post(`${API}/menu/products/${product.id}/image`).set(bearer(tok.waiterA)).attach('image', PNG, 'p.png').expect(403);
    });
  });

  describe('tenant isolation', () => {
    it('another organization cannot see or change this menu', async () => {
      await ctx.http().get(`${API}/menu/products/${product.id}`).set(bearer(tok.otherOwner)).expect(404);
      await ctx.http().patch(`${API}/menu/products/${product.id}`).set(bearer(tok.otherOwner)).send({ name: 'Hacked' }).expect(404);
      await ctx.http().get(`${API}/menu`).query({ branchId: fx.branchA }).set(bearer(tok.otherOwner)).expect(404);
      await ctx.http().get(`${API}/menu/categories/${categoryId}`).set(bearer(tok.otherOwner)).expect(404);
      const list = await ctx.http().get(`${API}/menu/products`).set(bearer(tok.otherOwner)).expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(product.id);
    });
  });
});
