-- AlterTable
ALTER TABLE "branch_product_prices" ADD COLUMN     "updated_by_id" UUID,
ALTER COLUMN "price" DROP NOT NULL;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "restaurant_tables" ADD COLUMN     "reservation_name" TEXT,
ADD COLUMN     "reservation_phone" VARCHAR(16),
ADD COLUMN     "reserved_until" TIMESTAMPTZ(3);

-- ───────────── Integrity rules for Phase 2 ─────────────
-- At most one default variant per product.
CREATE UNIQUE INDEX product_variants_one_default ON product_variants (product_id) WHERE is_default;
-- A reserved table records who it is reserved for.
ALTER TABLE restaurant_tables ADD CONSTRAINT restaurant_tables_reservation_named
  CHECK (status <> 'RESERVED' OR reservation_name IS NOT NULL);
ALTER TABLE restaurant_tables ADD CONSTRAINT restaurant_tables_geometry_valid
  CHECK (width > 0 AND height > 0 AND pos_x >= 0 AND pos_y >= 0 AND shape IN ('RECT', 'ROUND'));
-- A table that is merged into another session cannot itself be the target of a merge chain.
ALTER TABLE table_sessions ADD CONSTRAINT table_sessions_not_self_merged CHECK (merged_into_id IS DISTINCT FROM id);

-- ───────────── New permission: menu.availability.update ─────────────
-- Marking an item temporarily unavailable ("86") is separate from editing the menu so kitchen
-- staff can do it. Existing organizations get it on the roles that hold it by default.
INSERT INTO permissions (id, code, module, description)
VALUES (gen_random_uuid(), 'menu.availability.update', 'menu', 'Mark products available or temporarily unavailable')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, now()
FROM roles r
JOIN permissions p ON p.code = 'menu.availability.update'
WHERE r.key IN ('SUPER_ADMIN', 'OWNER', 'MANAGER', 'KITCHEN_STAFF')
ON CONFLICT DO NOTHING;
