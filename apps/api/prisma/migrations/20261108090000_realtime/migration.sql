-- Phase 4: kitchen display and realtime events.

-- Kitchen tickets record their last change so screens can resync with ?updatedSince=.
ALTER TABLE "kitchen_tickets" ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "kitchen_tickets_branch_id_updated_at_idx" ON "kitchen_tickets"("branch_id", "updated_at");

-- Waiters and cashiers see kitchen tickets (to pick up ready items).
INSERT INTO role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, now()
FROM roles r
JOIN permissions p ON p.code = 'kot.read'
WHERE r.key IN ('WAITER', 'CASHIER')
ON CONFLICT DO NOTHING;

-- ───────────── Transactional outbox ─────────────
CREATE TABLE "realtime_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pending_id" BIGSERIAL NOT NULL,
    "seq" BIGINT,
    "txid" BIGINT NOT NULL DEFAULT txid_current(),
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "topic" VARCHAR(20) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "entity_type" VARCHAR(30) NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_version" INTEGER,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    CONSTRAINT "realtime_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "realtime_events_published_has_seq" CHECK ((seq IS NULL) = (published_at IS NULL))
);
CREATE UNIQUE INDEX "realtime_events_seq_key" ON "realtime_events"("seq");
CREATE INDEX "realtime_events_branch_id_seq_idx" ON "realtime_events"("branch_id", "seq");
-- Used by the relay to find unpublished rows and by realtime_emit to merge repeats in one transaction.
CREATE INDEX "realtime_events_pending_idx" ON "realtime_events"("txid", "entity_id") WHERE seq IS NULL;

-- Several changes to one record inside one transaction become a single event carrying the final
-- state. A ".created" or ".cancelled" type is kept over a later ".updated".
CREATE FUNCTION realtime_emit(p_org uuid, p_branch uuid, p_topic text, p_type text, p_entity_type text,
                              p_entity_id uuid, p_version int, p_payload jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tx bigint := txid_current();
BEGIN
  UPDATE realtime_events
     SET payload = p_payload,
         entity_version = p_version,
         type = CASE WHEN type LIKE '%.created' OR type LIKE '%.cancelled' OR type LIKE '%.requested' THEN type ELSE p_type END
   WHERE seq IS NULL AND txid = tx AND entity_id = p_entity_id AND entity_type = p_entity_type AND topic = p_topic;
  IF NOT FOUND THEN
    INSERT INTO realtime_events (organization_id, branch_id, topic, type, entity_type, entity_id, entity_version, payload, txid)
    VALUES (p_org, p_branch, p_topic, p_type, p_entity_type, p_entity_id, p_version, p_payload, tx);
  END IF;
END $$;

-- Orders
CREATE FUNCTION realtime_orders() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    t := 'order.created';
  ELSIF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.version IS NOT DISTINCT FROM OLD.version
        AND NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status AND NEW.paid_amount IS NOT DISTINCT FROM OLD.paid_amount
        AND NEW.grand_total IS NOT DISTINCT FROM OLD.grand_total AND NEW.table_session_id IS NOT DISTINCT FROM OLD.table_session_id THEN
    RETURN NULL;
  ELSIF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' THEN
    t := 'order.cancelled';
  ELSE
    t := 'order.updated';
  END IF;
  PERFORM realtime_emit(NEW.organization_id, NEW.branch_id, 'orders', t, 'order', NEW.id, NEW.version,
    jsonb_build_object('id', NEW.id, 'orderNumber', NEW.order_number, 'orderType', NEW.order_type, 'status', NEW.status,
      'paymentStatus', NEW.payment_status, 'grandTotal', trim_scale(NEW.grand_total)::text, 'paidAmount', trim_scale(NEW.paid_amount)::text,
      'tableSessionId', NEW.table_session_id, 'version', NEW.version));
  RETURN NULL;
END $$;
CREATE TRIGGER orders_realtime AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION realtime_orders();

-- Tables
CREATE FUNCTION realtime_tables() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.version IS NOT DISTINCT FROM OLD.version
     AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  PERFORM realtime_emit(NEW.organization_id, NEW.branch_id, 'tables', 'table.status.updated', 'table', NEW.id, NEW.version,
    jsonb_build_object('id', NEW.id, 'label', NEW.label, 'status', NEW.status, 'isActive', NEW.is_active,
      'deleted', NEW.deleted_at IS NOT NULL, 'version', NEW.version));
  RETURN NULL;
END $$;
CREATE TRIGGER restaurant_tables_realtime AFTER INSERT OR UPDATE ON restaurant_tables FOR EACH ROW EXECUTE FUNCTION realtime_tables();

-- Kitchen tickets
CREATE FUNCTION realtime_kitchen_tickets() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    RETURN NULL;
  END IF;
  PERFORM realtime_emit(NEW.organization_id, NEW.branch_id, 'kitchen', CASE WHEN TG_OP = 'INSERT' THEN 'kot.created' ELSE 'kot.updated' END,
    'kot', NEW.id, NULL,
    jsonb_build_object('id', NEW.id, 'ticketNumber', NEW.ticket_number, 'orderId', NEW.order_id, 'stationId', NEW.station_id,
      'status', NEW.status));
  RETURN NULL;
END $$;
CREATE TRIGGER kitchen_tickets_realtime AFTER INSERT OR UPDATE ON kitchen_tickets FOR EACH ROW EXECUTE FUNCTION realtime_kitchen_tickets();

CREATE FUNCTION realtime_kitchen_ticket_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k kitchen_tickets%ROWTYPE;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  SELECT * INTO k FROM kitchen_tickets WHERE id = NEW.ticket_id;
  PERFORM realtime_emit(k.organization_id, k.branch_id, 'kitchen', 'kot.item.updated', 'kot_item', NEW.id, NULL,
    jsonb_build_object('id', NEW.id, 'ticketId', NEW.ticket_id, 'orderId', k.order_id, 'orderItemId', NEW.order_item_id,
      'stationId', k.station_id, 'status', NEW.status));
  RETURN NULL;
END $$;
CREATE TRIGGER kitchen_ticket_items_realtime AFTER UPDATE ON kitchen_ticket_items FOR EACH ROW EXECUTE FUNCTION realtime_kitchen_ticket_items();

-- Payments and refunds
CREATE FUNCTION realtime_payments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'COMPLETED' OR (TG_OP = 'UPDATE' AND OLD.status = 'COMPLETED') THEN
    RETURN NULL;
  END IF;
  PERFORM realtime_emit(NEW.organization_id, NEW.branch_id, 'payments', 'payment.completed', 'payment', NEW.id, NULL,
    jsonb_build_object('id', NEW.id, 'orderId', NEW.order_id, 'method', NEW.method, 'amount', trim_scale(NEW.amount)::text));
  RETURN NULL;
END $$;
CREATE TRIGGER payments_realtime AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION realtime_payments();

CREATE FUNCTION realtime_refunds() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  t := CASE NEW.status WHEN 'PENDING' THEN 'refund.requested' WHEN 'COMPLETED' THEN 'refund.completed' ELSE 'refund.rejected' END;
  PERFORM realtime_emit(NEW.organization_id, NEW.branch_id, 'payments', t, 'refund', NEW.id, NULL,
    jsonb_build_object('id', NEW.id, 'paymentId', NEW.payment_id, 'invoiceId', NEW.invoice_id, 'method', NEW.method,
      'amount', trim_scale(NEW.amount)::text, 'status', NEW.status));
  RETURN NULL;
END $$;
CREATE TRIGGER refunds_realtime AFTER INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION realtime_refunds();
