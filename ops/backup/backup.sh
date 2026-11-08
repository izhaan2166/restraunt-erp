#!/usr/bin/env bash
# Nightly PostgreSQL backup: a compressed custom-format dump, checked, optionally copied to S3,
# with old local copies pruned. Run from cron (see docs/backup-restore.md).
#
#   DATABASE_URL=postgresql://ros:...@host:5432/restaurant_os ./backup.sh
#
# Optional: BACKUP_DIR (default ./backups), BACKUP_KEEP_DAYS (default 14),
#           BACKUP_S3_URI (e.g. s3://my-bucket/restaurant-os; needs the aws CLI and credentials),
#           PRIVATE_UPLOAD_DIR (receipts folder to archive alongside, local storage only).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
umask 077

# Prisma-style URLs carry ?schema=public, which libpq does not understand.
PG_URL="${DATABASE_URL%%\?*}"
DUMP="$BACKUP_DIR/restaurant_os-$STAMP.dump"

echo "[$(date -u +%FT%TZ)] dumping database to $DUMP"
pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$DUMP.partial" "$PG_URL"
# A dump that cannot be listed is not a backup.
pg_restore --list "$DUMP.partial" > /dev/null
mv "$DUMP.partial" "$DUMP"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP")" > "$(basename "$DUMP").sha256")
echo "[$(date -u +%FT%TZ)] dump ok: $(du -h "$DUMP" | cut -f1)"

FILES=("$DUMP" "$DUMP.sha256")
if [[ -n "${PRIVATE_UPLOAD_DIR:-}" && -d "$PRIVATE_UPLOAD_DIR" ]]; then
  RECEIPTS="$BACKUP_DIR/receipts-$STAMP.tar.gz"
  tar -czf "$RECEIPTS" -C "$PRIVATE_UPLOAD_DIR" .
  FILES+=("$RECEIPTS")
  echo "[$(date -u +%FT%TZ)] receipts archived: $(du -h "$RECEIPTS" | cut -f1)"
fi

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  for f in "${FILES[@]}"; do
    aws s3 cp --only-show-errors --sse AES256 "$f" "${BACKUP_S3_URI%/}/$(basename "$f")"
  done
  echo "[$(date -u +%FT%TZ)] copied to $BACKUP_S3_URI"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'restaurant_os-*.dump*' -o -name 'receipts-*.tar.gz' \) -mtime +"$KEEP_DAYS" -print -delete
echo "[$(date -u +%FT%TZ)] backup finished"
