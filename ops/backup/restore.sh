#!/usr/bin/env bash
# Restores a backup made by backup.sh into a database. By default it refuses to overwrite a
# database that already has data; restore into a fresh database first and check it.
#
#   TARGET_DATABASE_URL=postgresql://ros:...@host:5432/restaurant_os_restore ./restore.sh backups/restaurant_os-XXXX.dump
#
# Add --force to replace the contents of a non-empty database (stop the API first).
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump file> [--force]}"
FORCE="${2:-}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
PG_URL="${TARGET_DATABASE_URL%%\?*}"

if [[ -f "$DUMP.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && sha256sum --check --status "$(basename "$DUMP").sha256") || { echo "checksum mismatch for $DUMP" >&2; exit 1; }
fi
pg_restore --list "$DUMP" > /dev/null

TABLES="$(psql "$PG_URL" -tAc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [[ "$TABLES" != "0" && "$FORCE" != "--force" ]]; then
  echo "target database already has $TABLES tables; restore into an empty database or pass --force" >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] restoring $DUMP"
# --clean drops existing objects first (only matters with --force); one transaction: all or nothing.
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error --dbname="$PG_URL" "$DUMP"

# Sanity check: the migration history and the core tables came back.
psql "$PG_URL" -v ON_ERROR_STOP=1 -tA <<'SQL'
select 'migrations applied: ' || count(*) from _prisma_migrations where finished_at is not null;
select 'organizations: ' || count(*) from organizations;
select 'invoices: ' || count(*) from invoices;
SQL
echo "[$(date -u +%FT%TZ)] restore finished"
