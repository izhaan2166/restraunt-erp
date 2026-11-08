-- Phase 6: expenses, employees, attendance, cash shifts.

-- Cash payments and refunds go through the cashier's open drawer unless a branch turns this off.
ALTER TABLE branch_settings ADD COLUMN cash_requires_shift boolean NOT NULL DEFAULT true;

-- Deleting an expense keeps the row and says why.
ALTER TABLE expenses ADD COLUMN delete_reason text;
ALTER TABLE expenses ADD CONSTRAINT expenses_tax_within_amount CHECK (tax_amount <= amount);
ALTER TABLE expenses ADD CONSTRAINT expenses_delete_reason CHECK (deleted_at IS NULL OR (delete_reason IS NOT NULL AND deleted_by_id IS NOT NULL));

-- Money into the drawer is positive, money out negative; an expense entry may be reversed.
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_sign CHECK (
  (type IN ('OPENING_FLOAT') AND amount > 0) OR
  (type IN ('CASH_SALE', 'CASH_IN') AND amount > 0) OR
  (type IN ('CASH_REFUND', 'CASH_OUT') AND amount < 0) OR
  type = 'EXPENSE');

-- A closed drawer is final: no new entries, no edits.
CREATE FUNCTION cash_movements_need_open_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cash_sessions WHERE id = NEW.cash_session_id AND status = 'OPEN') THEN
    RAISE EXCEPTION 'cash session % is not open', NEW.cash_session_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_movements_open_session BEFORE INSERT ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION cash_movements_need_open_session();

CREATE FUNCTION cash_sessions_guard_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'cash session % is closed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER cash_sessions_closed_final BEFORE UPDATE OR DELETE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION cash_sessions_guard_closed();

-- One open attendance (clocked in, not out) per employee.
CREATE UNIQUE INDEX attendance_one_open_per_employee ON attendance (employee_id)
  WHERE clock_in_at IS NOT NULL AND clock_out_at IS NULL;

-- Realtime: shift.opened / shift.closed on topic "shifts"; a notification when a drawer is short or over.
CREATE FUNCTION realtime_cash_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  who text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  SELECT full_name INTO who FROM users WHERE id = NEW.user_id;
  PERFORM realtime_emit(NEW.organization_id, NEW.branch_id, 'shifts',
    CASE NEW.status WHEN 'OPEN' THEN 'shift.opened' ELSE 'shift.closed' END, 'cash_session', NEW.id, NULL,
    jsonb_build_object('id', NEW.id, 'userId', NEW.user_id, 'cashier', who, 'terminal', NEW.terminal, 'status', NEW.status,
      'openingBalance', trim_scale(NEW.opening_balance)::text,
      'expectedCash', trim_scale(NEW.expected_cash)::text, 'actualCash', trim_scale(NEW.actual_cash)::text,
      'discrepancy', trim_scale(NEW.discrepancy)::text));
  IF NEW.status = 'CLOSED' AND NEW.discrepancy <> 0 THEN
    INSERT INTO notifications (id, organization_id, branch_id, type, title, body, data, created_at)
    VALUES (gen_random_uuid(), NEW.organization_id, NEW.branch_id, 'shift.discrepancy',
      'Cash ' || CASE WHEN NEW.discrepancy < 0 THEN 'short' ELSE 'over' END || ': ' || coalesce(who, 'cashier'),
      'Drawer closed ₹' || trim_scale(abs(NEW.discrepancy))::text || CASE WHEN NEW.discrepancy < 0 THEN ' short' ELSE ' over' END
        || ' (expected ₹' || trim_scale(NEW.expected_cash)::text || ', counted ₹' || trim_scale(NEW.actual_cash)::text || ')',
      jsonb_build_object('cashSessionId', NEW.id), now());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cash_sessions_realtime AFTER INSERT OR UPDATE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION realtime_cash_sessions();
