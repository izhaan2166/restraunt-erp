# Backups and restore

Everything that matters lives in two places:

- **PostgreSQL** holds orders, invoices, payments, stock, expenses, users and the audit log.
- **The private uploads folder** holds expense receipts when `STORAGE_DRIVER=local`. With S3, use the bucket's versioning and replication instead.

Redis holds only rate-limit counters and needs no backup.

| Target | Value |
|---|---|
| Recovery point (data you can lose) | At most 24 hours with nightly dumps. Minutes with managed point-in-time recovery or WAL archiving (§4). |
| Recovery time | About 15 minutes for a database of a few GB. |
| Retention | 14 daily copies on the server, and longer off-site through an S3 lifecycle rule (for example 90 days, then archive tier). GST records must be kept for at least 6 years (72 months), so keep yearly copies too. |

## 1. Nightly backup: `ops/backup/backup.sh`

The script does five things:

1. Takes a compressed `pg_dump` in custom format, so single tables can be restored.
2. Checks that the dump can be read before keeping it.
3. Writes a SHA-256 checksum.
4. Archives the private receipts folder, when `PRIVATE_UPLOAD_DIR` is set.
5. Copies everything to S3 when `BACKUP_S3_URI` is set, encrypted at rest, then deletes local copies older than `BACKUP_KEEP_DAYS`.

It needs `pg_dump` and `pg_restore` 16 (`apt install postgresql-client-16`) and, for the off-site copy, the AWS CLI.

```bash
export DATABASE_URL='postgresql://ros:PASSWORD@localhost:5432/restaurant_os'
export BACKUP_DIR=/var/backups/ros BACKUP_KEEP_DAYS=14
export BACKUP_S3_URI=s3://yourrestaurant-backups/restaurant-os
export PRIVATE_UPLOAD_DIR=/var/lib/docker/volumes/restaurant-os_uploads_private/_data
ops/backup/backup.sh
```

In the one-server Compose layout PostgreSQL has no published port. Either run the script inside a container on the backend network:

```bash
docker run --rm --network restaurant-os_backend -v /var/backups/ros:/backups -v "$PWD/ops/backup:/ops:ro" \
  -e DATABASE_URL="postgresql://ros:$POSTGRES_PASSWORD@postgres:5432/restaurant_os" -e BACKUP_DIR=/backups \
  postgres:16-alpine sh -c 'apk add --no-cache bash coreutils >/dev/null && bash /ops/backup.sh'
```

or use the `pg_dump` cron line in [deployment.md](deployment.md) §2.

Schedule it nightly from cron, and send the log somewhere you read. A backup that silently stopped is the most common way to lose data.

```cron
0 21 * * * /opt/restraunt-erp/ops/backup/backup.sh >> /var/log/ros-backup.log 2>&1 || echo "RestaurantOS backup FAILED" | mail -s "backup failed" ops@yourrestaurant.in
```

## 2. Restore: `ops/backup/restore.sh`

The script:

- verifies the checksum;
- refuses to overwrite a database that already has tables, unless you pass `--force`;
- restores in one transaction, so a failed restore leaves nothing half-done;
- prints the migration count and row counts as a sanity check.

### Restore drill (do this monthly)

Restore last night's backup into a scratch database and compare:

```bash
createdb -h localhost -U ros ros_restore_check
TARGET_DATABASE_URL=postgresql://ros:PASSWORD@localhost:5432/ros_restore_check \
  ops/backup/restore.sh /var/backups/ros/restaurant_os-20261108T210000Z.dump
# migrations applied: 8
# organizations: 1
# invoices: 18342
dropdb -h localhost -U ros ros_restore_check
```

The invoice count should match the live database as of the backup time. The drill was tested end to end on 2026-11-08 against the integration-test database (1,852 invoices, 442 organizations), including the refusal to overwrite and the `--force` path.

### Recovering production after data loss

1. **Stop writes:** `docker compose -f ops/production/docker-compose.prod.yml stop api`. Tell the branches to take orders on paper for a few minutes.
2. **Keep evidence:** take a dump of the current, damaged database first (`backup.sh` with `BACKUP_DIR=/var/backups/ros/pre-restore`).
3. **Restore** the chosen backup over the live database:
   ```bash
   TARGET_DATABASE_URL=postgresql://ros:PASSWORD@localhost:5432/restaurant_os \
     ops/backup/restore.sh /var/backups/ros/restaurant_os-<stamp>.dump --force
   ```
4. **Restore receipts**, if needed: `tar -xzf receipts-<stamp>.tar.gz -C <uploads_private volume path>`.
5. **Start the API:** `docker compose ... up -d api`, then check `health/ready`.
6. **Re-enter the paper orders.** Invoice numbers continue from the restored sequence, so numbering stays gap-free from the restore point. Note the restore time in the audit trail by recording a short expense or a note through the owner account.

Finalized invoices, credit notes, stock ledgers, cash entries and audit logs are protected by database triggers, and they come back exactly as they were. The restore never recalculates them.

## 3. Restoring one table or one organization

A custom-format dump can restore selected objects. For example, to recover expenses into a scratch database and then copy specific rows back with SQL:

```bash
pg_restore --list dump.dump | grep -i expense
pg_restore --data-only --table=expenses --dbname=postgresql://.../ros_restore_check dump.dump
```

Copy rows back with `INSERT … SELECT` inside a transaction, and record what you did in the audit log. Do not edit finalized invoices: correct them with credit notes through the API.

## 4. Point-in-time recovery

To lose minutes instead of up to a day:

- **Managed PostgreSQL** (RDS, Aurora, Cloud SQL, Azure): turn on automated backups with point-in-time recovery, set at least 7 days of retention, and keep `backup.sh` running for long-term copies.
- **Self-hosted:** use WAL archiving with pgBackRest or WAL-G to the same S3 bucket. Configure it on the `postgres` service with `archive_mode=on` and an `archive_command`, following the tool's quick-start. Test recovery to a timestamp during the monthly drill.
