import { Prisma, SequenceType } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const IST_OFFSET_MS = 5.5 * 3600_000;

/** Calendar date in India (business day), e.g. "20261108". */
export function istDay(at: Date = new Date()): string {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Indian financial year (April–March) in the short form used on GST documents, e.g. "2627". */
export function financialYear(at: Date = new Date()): string {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Allocates the next number of a document series atomically. The row is created on first use
 * and incremented with a single upsert, so concurrent callers can never get the same number; it
 * runs inside the caller's transaction, so a rolled-back document does not consume a number.
 */
export async function nextNumber(
  tx: Tx,
  args: { organizationId: string; branchId: string; type: SequenceType; prefix: string; period: string },
): Promise<{ sequenceId: string; value: number }> {
  const rows = await tx.$queryRaw<{ id: string; value: number }[]>`
    INSERT INTO document_sequences (id, organization_id, branch_id, type, prefix, period, next_value, updated_at)
    VALUES (gen_random_uuid(), ${args.organizationId}::uuid, ${args.branchId}::uuid, ${args.type}::"SequenceType",
            ${args.prefix}, ${args.period}, 2, now())
    ON CONFLICT (branch_id, type, prefix, period)
    DO UPDATE SET next_value = document_sequences.next_value + 1, updated_at = now()
    RETURNING id, next_value - 1 AS value`;
  return { sequenceId: rows[0].id, value: Number(rows[0].value) };
}
