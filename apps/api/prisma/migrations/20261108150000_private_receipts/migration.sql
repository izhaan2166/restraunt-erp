-- Receipts become private: the file is addressed by a storage key that is never sent to clients,
-- and receipt_url becomes the authenticated API path that streams (or redirects to) the file.
ALTER TABLE "expenses" ADD COLUMN "receipt_key" TEXT;

-- Move existing rows: the key is the "<org>/receipts/<file>" tail of the old public URL.
UPDATE "expenses"
SET "receipt_key" = substring("receipt_url" FROM '([0-9a-fA-F-]{36}/receipts/[^/?#]+)$'),
    "receipt_url" = '/api/v1/expenses/' || "id" || '/receipt'
WHERE "receipt_url" ~ '[0-9a-fA-F-]{36}/receipts/[^/?#]+$';
