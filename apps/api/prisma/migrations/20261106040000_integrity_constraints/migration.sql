-- Integrity rules Prisma's schema language cannot express.
-- Kept in their own migration so the intent is easy to review.

-- ───────────── Format checks ─────────────
ALTER TABLE organizations ADD CONSTRAINT organizations_gstin_format
  CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
ALTER TABLE organizations ADD CONSTRAINT organizations_state_code_format
  CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$');
ALTER TABLE branches ADD CONSTRAINT branches_gstin_format
  CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
ALTER TABLE branches ADD CONSTRAINT branches_state_code_format CHECK (state_code ~ '^[0-9]{2}$');
ALTER TABLE suppliers ADD CONSTRAINT suppliers_gstin_format
  CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));
ALTER TABLE users ADD CONSTRAINT users_failed_attempts_nonneg CHECK (failed_login_attempts >= 0);

-- ───────────── Uniqueness with NULLs / partial uniqueness ─────────────
CREATE UNIQUE INDEX user_roles_user_role_branch_key
  ON user_roles (user_id, role_id, branch_id) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX branch_product_prices_key
  ON branch_product_prices (branch_id, product_id, variant_id) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX recipes_one_active_per_product
  ON recipes (product_id, variant_id) NULLS NOT DISTINCT WHERE is_active;
CREATE UNIQUE INDEX table_sessions_one_open_per_table
  ON table_sessions (table_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX cash_sessions_one_open_per_cashier
  ON cash_sessions (branch_id, user_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX invoices_one_active_per_order
  ON invoices (order_id) WHERE status <> 'CANCELLED';
CREATE UNIQUE INDEX categories_name_active_key
  ON categories (organization_id, lower(name)) WHERE deleted_at IS NULL;

-- ───────────── Money / quantity checks ─────────────
ALTER TABLE restaurant_tables ADD CONSTRAINT restaurant_tables_capacity_pos CHECK (capacity > 0);
ALTER TABLE table_sessions ADD CONSTRAINT table_sessions_guests_pos CHECK (guest_count > 0);
ALTER TABLE document_sequences ADD CONSTRAINT document_sequences_next_pos CHECK (next_value >= 1);
ALTER TABLE branch_settings ADD CONSTRAINT branch_settings_pct_range
  CHECK (service_charge_percent BETWEEN 0 AND 100 AND max_cashier_discount_pct BETWEEN 0 AND 100);

ALTER TABLE tax_rates ADD CONSTRAINT tax_rates_valid CHECK (
  rate BETWEEN 0 AND 100 AND cgst_rate >= 0 AND sgst_rate >= 0 AND igst_rate >= 0 AND cess_rate >= 0
  AND cgst_rate + sgst_rate = rate AND igst_rate = rate AND cgst_rate = sgst_rate
  AND (effective_to IS NULL OR effective_to > effective_from));

ALTER TABLE products ADD CONSTRAINT products_price_nonneg CHECK (base_price >= 0);
ALTER TABLE products ADD CONSTRAINT products_hsn_format CHECK (hsn_sac IS NULL OR hsn_sac ~ '^[0-9]{4,8}$');
ALTER TABLE product_variants ADD CONSTRAINT product_variants_price_nonneg CHECK (price >= 0);
ALTER TABLE modifiers ADD CONSTRAINT modifiers_price_nonneg CHECK (price >= 0);
ALTER TABLE modifier_groups ADD CONSTRAINT modifier_groups_select_range CHECK (min_select >= 0 AND max_select >= min_select);
ALTER TABLE branch_product_prices ADD CONSTRAINT branch_product_prices_nonneg CHECK (price >= 0);
ALTER TABLE combo_items ADD CONSTRAINT combo_items_qty_pos CHECK (quantity > 0 AND combo_product_id <> product_id);

ALTER TABLE orders ADD CONSTRAINT orders_amounts_valid CHECK (
  subtotal >= 0 AND discount_total >= 0 AND discount_total <= subtotal AND taxable_amount >= 0
  AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND tax_total >= 0
  AND service_charge >= 0 AND grand_total >= 0 AND paid_amount >= 0 AND round_off BETWEEN -1 AND 1);
ALTER TABLE orders ADD CONSTRAINT orders_cancel_reason_required CHECK (
  status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0 AND cancelled_by_id IS NOT NULL));
ALTER TABLE orders ADD CONSTRAINT orders_dine_in_needs_table CHECK (order_type <> 'DINE_IN' OR table_session_id IS NOT NULL);

ALTER TABLE order_items ADD CONSTRAINT order_items_amounts_valid CHECK (
  quantity > 0 AND unit_price >= 0 AND modifiers_total >= 0 AND line_subtotal >= 0
  AND discount_amount >= 0 AND discount_amount <= line_subtotal AND taxable_amount >= 0
  AND tax_rate BETWEEN 0 AND 100 AND tax_amount >= 0 AND line_total >= 0);
ALTER TABLE order_items ADD CONSTRAINT order_items_cancel_reason_required CHECK (
  status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND cancelled_by_id IS NOT NULL));
ALTER TABLE order_item_modifiers ADD CONSTRAINT order_item_modifiers_valid CHECK (price >= 0 AND quantity > 0);
ALTER TABLE kitchen_ticket_items ADD CONSTRAINT kitchen_ticket_items_qty_pos CHECK (quantity > 0);

ALTER TABLE discounts ADD CONSTRAINT discounts_value_valid CHECK (
  value > 0 AND (type <> 'PERCENTAGE' OR value <= 100) AND (max_amount IS NULL OR max_amount > 0));
ALTER TABLE applied_discounts ADD CONSTRAINT applied_discounts_valid CHECK (
  value > 0 AND amount >= 0 AND (type <> 'PERCENTAGE' OR value <= 100)
  AND (scope <> 'ITEM' OR order_item_id IS NOT NULL));

ALTER TABLE invoices ADD CONSTRAINT invoices_amounts_valid CHECK (
  subtotal >= 0 AND discount_total >= 0 AND taxable_amount >= 0 AND cgst_amount >= 0
  AND sgst_amount >= 0 AND igst_amount >= 0 AND tax_total = cgst_amount + sgst_amount + igst_amount
  AND grand_total >= 0 AND paid_amount >= 0 AND paid_amount <= grand_total
  AND refunded_amount >= 0 AND refunded_amount <= paid_amount AND round_off BETWEEN -1 AND 1
  AND (supply_type <> 'INTRA_STATE' OR igst_amount = 0)
  AND (supply_type <> 'INTER_STATE' OR (cgst_amount = 0 AND sgst_amount = 0)));
ALTER TABLE invoices ADD CONSTRAINT invoices_finalized_has_actor CHECK (
  status <> 'FINALIZED' OR (finalized_at IS NOT NULL AND finalized_by_id IS NOT NULL));
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_amounts_valid CHECK (
  quantity > 0 AND unit_price >= 0 AND discount >= 0 AND taxable_amount >= 0
  AND cgst_amount >= 0 AND sgst_amount >= 0 AND igst_amount >= 0 AND line_total >= 0);

ALTER TABLE payments ADD CONSTRAINT payments_amount_pos CHECK (amount > 0);
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_amount_pos CHECK (amount > 0);
ALTER TABLE refunds ADD CONSTRAINT refunds_valid CHECK (amount > 0 AND length(trim(reason)) > 0);
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_amount_pos CHECK (total_amount > 0 AND taxable_amount >= 0);
ALTER TABLE credit_note_items ADD CONSTRAINT credit_note_items_valid CHECK (quantity > 0 AND line_total >= 0);

ALTER TABLE units ADD CONSTRAINT units_factor_pos CHECK (factor_to_base > 0);
ALTER TABLE recipes ADD CONSTRAINT recipes_yield_pos CHECK (yield_quantity > 0);
ALTER TABLE recipe_items ADD CONSTRAINT recipe_items_valid CHECK (quantity > 0 AND wastage_percent BETWEEN 0 AND 100);
ALTER TABLE inventory_balances ADD CONSTRAINT inventory_balances_valid CHECK (minimum_level >= 0 AND average_cost >= 0);
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_qty_nonzero CHECK (quantity <> 0);
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_sign_matches_type CHECK (
  (type IN ('PURCHASE_RECEIPT','SALE_REVERSAL','ADJUSTMENT_IN','TRANSFER_IN') AND quantity > 0)
  OR (type IN ('SALE_CONSUMPTION','WASTAGE','ADJUSTMENT_OUT','TRANSFER_OUT') AND quantity < 0)
  OR type = 'OPENING');
ALTER TABLE stock_adjustments ADD CONSTRAINT stock_adjustments_qty_nonzero CHECK (quantity <> 0 AND length(trim(reason)) > 0);
ALTER TABLE wastage_records ADD CONSTRAINT wastage_records_valid CHECK (quantity > 0 AND cost >= 0);

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_amounts_valid CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0);
ALTER TABLE purchase_order_items ADD CONSTRAINT purchase_order_items_valid CHECK (
  quantity > 0 AND received_quantity >= 0 AND unit_price >= 0 AND tax_rate BETWEEN 0 AND 100 AND line_total >= 0);
ALTER TABLE goods_receipt_items ADD CONSTRAINT goods_receipt_items_valid CHECK (quantity > 0 AND base_quantity > 0 AND unit_price >= 0);
ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_amounts_valid CHECK (
  subtotal >= 0 AND tax_total >= 0 AND total >= 0 AND paid_amount >= 0 AND paid_amount <= total);
ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_amount_pos CHECK (amount > 0);

ALTER TABLE expenses ADD CONSTRAINT expenses_amounts_valid CHECK (amount > 0 AND tax_amount >= 0);
ALTER TABLE cash_sessions ADD CONSTRAINT cash_sessions_valid CHECK (
  opening_balance >= 0 AND (actual_cash IS NULL OR actual_cash >= 0)
  AND (status <> 'CLOSED' OR (closed_at IS NOT NULL AND closed_by_id IS NOT NULL
       AND expected_cash IS NOT NULL AND actual_cash IS NOT NULL AND discrepancy = actual_cash - expected_cash)));
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_amount_nonzero CHECK (amount <> 0);
ALTER TABLE employee_shifts ADD CONSTRAINT employee_shifts_range CHECK (scheduled_end > scheduled_start);
ALTER TABLE attendance ADD CONSTRAINT attendance_clock_range CHECK (clock_out_at IS NULL OR clock_in_at IS NULL OR clock_out_at >= clock_in_at);

-- ───────────── Append-only ledgers ─────────────
CREATE OR REPLACE FUNCTION ros_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION ros_forbid_mutation();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION ros_forbid_mutation();
CREATE TRIGGER order_status_history_append_only BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION ros_forbid_mutation();
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION ros_forbid_mutation();

-- ───────────── Finalized invoices are immutable ─────────────
-- Only payment progress (paid/refunded amounts, payment_status) and a move to CANCELLED
-- (which the application only does alongside a full credit note) may change.
CREATE OR REPLACE FUNCTION ros_guard_finalized_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'invoice % is % and cannot be deleted', OLD.invoice_number, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.invoice_number IS DISTINCT FROM OLD.invoice_number OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
    OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.sequence_id IS DISTINCT FROM OLD.sequence_id
    OR NEW.supply_type IS DISTINCT FROM OLD.supply_type OR NEW.place_of_supply IS DISTINCT FROM OLD.place_of_supply
    OR NEW.seller_details IS DISTINCT FROM OLD.seller_details OR NEW.buyer_name IS DISTINCT FROM OLD.buyer_name
    OR NEW.buyer_gstin IS DISTINCT FROM OLD.buyer_gstin OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
    OR NEW.discount_total IS DISTINCT FROM OLD.discount_total OR NEW.taxable_amount IS DISTINCT FROM OLD.taxable_amount
    OR NEW.cgst_amount IS DISTINCT FROM OLD.cgst_amount OR NEW.sgst_amount IS DISTINCT FROM OLD.sgst_amount
    OR NEW.igst_amount IS DISTINCT FROM OLD.igst_amount OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
    OR NEW.service_charge IS DISTINCT FROM OLD.service_charge OR NEW.round_off IS DISTINCT FROM OLD.round_off
    OR NEW.grand_total IS DISTINCT FROM OLD.grand_total OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
    OR NEW.finalized_by_id IS DISTINCT FROM OLD.finalized_by_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
    OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'FINALIZED' AND NEW.status = 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invoice % is % and its contents cannot be modified; issue a credit note instead',
      OLD.invoice_number, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_guard_finalized BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION ros_guard_finalized_invoice();

CREATE OR REPLACE FUNCTION ros_guard_finalized_invoice_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv_status "InvoiceStatus";
BEGIN
  SELECT status INTO inv_status FROM invoices
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF inv_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'invoice items of a % invoice cannot be changed', inv_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER invoice_items_guard_finalized BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION ros_guard_finalized_invoice_items();
