-- Phase 5: inventory, recipes, suppliers and purchasing.

-- New permission: maintain the ingredient catalog and minimum stock levels.
INSERT INTO permissions (id, code, module, description)
VALUES (gen_random_uuid(), 'inventory.manage', 'inventory', 'Create and edit ingredients and minimum stock levels')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, now()
FROM roles r
JOIN permissions p ON p.code = 'inventory.manage'
WHERE r.key IN ('SUPER_ADMIN', 'OWNER', 'MANAGER', 'INVENTORY_MANAGER')
ON CONFLICT DO NOTHING;

-- Ingredient SKUs are unique within an organization when given.
CREATE UNIQUE INDEX ingredients_org_sku_key ON ingredients (organization_id, sku) WHERE sku IS NOT NULL;
-- Purchase order and receipt lines are listed in the order they were entered.
ALTER TABLE purchase_order_items ADD COLUMN line_no INTEGER NOT NULL DEFAULT 0;
-- Received quantity never exceeds what was ordered.
ALTER TABLE purchase_order_items ADD CONSTRAINT purchase_order_items_not_over_received CHECK (received_quantity <= quantity);
-- Cancelled purchase orders keep their reason.
ALTER TABLE purchase_orders ADD COLUMN cancel_reason TEXT;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_cancel_reason CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL);
-- Supplier invoice totals add up.
ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_total_adds_up CHECK (total = subtotal + tax_total);

-- ───────────── Low-stock alerts ─────────────
-- When a balance falls below its minimum (or rises back above it) a realtime event is written in
-- the same transaction, plus a notification for the branch when it falls below.
CREATE FUNCTION realtime_inventory_balances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  was_low boolean;
  is_low boolean := NEW.minimum_level > 0 AND NEW.quantity < NEW.minimum_level;
  ing record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    was_low := false;
  ELSE
    was_low := OLD.minimum_level > 0 AND OLD.quantity < OLD.minimum_level;
  END IF;
  IF was_low = is_low THEN
    RETURN NULL;
  END IF;
  SELECT i.name, u.code AS unit INTO ing FROM ingredients i JOIN units u ON u.id = i.base_unit_id WHERE i.id = NEW.ingredient_id;
  PERFORM realtime_emit(NEW.organization_id, NEW.branch_id, 'inventory',
    CASE WHEN is_low THEN 'inventory.low_stock' ELSE 'inventory.restocked' END, 'ingredient', NEW.ingredient_id, NEW.version,
    jsonb_build_object('ingredientId', NEW.ingredient_id, 'name', ing.name, 'unit', ing.unit,
      'quantity', trim_scale(NEW.quantity)::text, 'minimumLevel', trim_scale(NEW.minimum_level)::text));
  IF is_low THEN
    INSERT INTO notifications (id, organization_id, branch_id, type, title, body, data, created_at)
    VALUES (gen_random_uuid(), NEW.organization_id, NEW.branch_id, 'inventory.low_stock',
      'Low stock: ' || ing.name,
      trim_scale(NEW.quantity)::text || ' ' || ing.unit || ' left (minimum ' || trim_scale(NEW.minimum_level)::text || ' ' || ing.unit || ')',
      jsonb_build_object('ingredientId', NEW.ingredient_id), now());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER inventory_balances_realtime AFTER INSERT OR UPDATE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION realtime_inventory_balances();
