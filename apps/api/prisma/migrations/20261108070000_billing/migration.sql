-- ───────────── Phase 3: billing ─────────────
-- Invoice numbers are unique per organization, so each branch needs its own invoice prefix.
-- Existing branches still on the default 'INV' get their branch code (≤ 10 chars).
UPDATE branch_settings bs
SET invoice_prefix = left(b.code, 10)
FROM branches b
WHERE b.id = bs.branch_id AND bs.invoice_prefix = 'INV';

CREATE UNIQUE INDEX "branch_settings_invoice_prefix_key" ON "branch_settings"("organization_id", "invoice_prefix");

-- Managers issue credit notes (bill corrections) for their branch by default.
INSERT INTO role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, now()
FROM roles r
JOIN permissions p ON p.code = 'credit_notes.create'
WHERE r.key = 'MANAGER'
ON CONFLICT DO NOTHING;

-- A completed or voided refund records who decided it.
ALTER TABLE refunds ADD CONSTRAINT refunds_approved_when_final
  CHECK (status = 'PENDING' OR approved_by_id IS NOT NULL);

-- Invoice lines keep their printed order.
ALTER TABLE "invoice_items" ADD COLUMN "line_no" INTEGER NOT NULL DEFAULT 0;
