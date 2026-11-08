# Deploying RestaurantOS

This guide takes the API from the repository to a live HTTPS address. Two layouts are covered:

1. **One server** (most restaurant groups): Docker Compose with Caddy, PostgreSQL and Redis on the same machine. Files are in `ops/production/`.
2. **Managed cloud**: the same container image on a container service, with managed PostgreSQL, Redis and S3.

Both run the same image, built from `apps/api/Dockerfile`.

## What you need

| Item | Notes |
|---|---|
| Linux server | 2 vCPU and 4 GB RAM is enough for about 20 branches. Ubuntu 24.04 LTS with Docker Engine 27+ and the compose plugin. |
| Domain name | For example `api.yourrestaurant.in`, with its DNS `A` record pointing at the server. |
| Email account for sending | Any SMTP service: Amazon SES (Mumbai region), Zoho Mail, SendGrid, Google Workspace. Used for password resets. |
| Off-site storage for backups | Any S3-compatible bucket, such as AWS S3, Cloudflare R2 or Backblaze B2. |

## 1. One server with Docker Compose

```bash
git clone https://github.com/izhaan2166/restraunt-erp.git && cd restraunt-erp
cp .env.example .env.production
```

Edit `.env.production`. The API refuses to start in production when a setting below is unsafe, and it names the setting that is wrong.

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` |
| `API_DOMAIN` | `api.yourrestaurant.in`. Caddy gets the TLS certificate for this name. |
| `POSTGRES_PASSWORD` | Generate with `openssl rand -base64 32`. |
| `JWT_ACCESS_SECRET` | Generate with `openssl rand -base64 48`. Placeholder-looking values are rejected. |
| `CORS_ORIGINS` | The `https://` addresses of the web app, comma-separated. `*`, `http://` and `localhost` are rejected. |
| `APP_PUBLIC_URL` | The `https://` address of the web app. Password-reset links point here. |
| `MAIL_TRANSPORT` | `smtp` |
| `SMTP_URL` | For example `smtps://USER:PASS@email-smtp.ap-south-1.amazonaws.com:465`. |
| `MAIL_FROM` | For example `Spice Garden <no-reply@yourrestaurant.in>`. The domain must be verified with your mail provider. |
| `METRICS_TOKEN` | Generate with `openssl rand -hex 24`. See [monitoring.md](monitoring.md). |
| `SEED_DEMO` | `false` |
| `STORAGE_DRIVER` | `local` stores files on the server's volumes. `s3` stores them in a bucket (see §3). |

`COOKIE_SECURE` defaults to `true` in production, and setting it to `false` is rejected. `TRUST_PROXY` is set to `true` by the compose file because Caddy sits in front of the API.

Start the stack:

```bash
docker compose -f ops/production/docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f ops/production/docker-compose.prod.yml logs -f migrate api
```

On the first start:

1. `migrate` applies every database migration and loads the reference data: GST rates, units and the permission catalogue.
2. `api` starts once `migrate` has succeeded.
3. Caddy obtains the certificate.

Then check:

```bash
curl -s https://api.yourrestaurant.in/api/v1/health/ready
# {"data":{"status":"ok","database":"up","redis":"up"}}
```

PostgreSQL and Redis are on an internal network with no published ports, and the public proxy does not serve `/api/v1/metrics`.

### Create the first organization and owner

The demo seed is off in production. Create the real organization once, with its first branch and the owner's account:

```bash
docker compose -f ops/production/docker-compose.prod.yml --env-file .env.production run --rm \
  -e ORG_NAME="Spice Garden" -e ORG_LEGAL_NAME="Spice Garden Foods Pvt Ltd" \
  -e ORG_STATE_CODE=29 -e ORG_GSTIN=29AABCS1234F1Z5 \
  -e BRANCH_NAME="Indiranagar" -e BRANCH_CODE=BLR-IND \
  -e OWNER_EMAIL=owner@spicegarden.in -e OWNER_NAME="Asha Rao" -e OWNER_PASSWORD='choose-a-strong-one-2026' \
  migrate node dist-seed/prisma/create-organization.js
```

- The GSTIN is checked against the state code. The PAN is taken from the GSTIN.
- The branch gets an invoice prefix made from its code (`BLRIND`) and a Main Kitchen station.
- The owner gets the Restaurant Owner role for every branch.
- Running the command again with the same email changes nothing.

Then sign in as the owner. The [admin guide](admin-guide.md) covers adding branches, staff, the menu and tables.

### Updating to a new version

```bash
git pull
ops/backup/backup.sh                 # always back up before an upgrade (see backup-restore.md)
docker compose -f ops/production/docker-compose.prod.yml --env-file .env.production up -d --build
```

`migrate` runs again and applies only new migrations. Every migration in this repository only adds to the schema, or moves data inside one transaction, so the old API keeps working while the new one starts. If a migration fails, the old containers keep running; read `docker compose logs migrate`.

To roll back the application, check out the previous tag and run the same command. Migrations are not rolled back automatically. If a release says its migration is not backward compatible, restore the pre-upgrade backup instead ([backup-restore.md](backup-restore.md)).

## 2. Scheduled jobs on the server

Add these to the host's crontab (`crontab -e`). They assume the repository is in `/opt/restraunt-erp`.

```cron
# Nightly database + receipts backup at 02:30 IST (21:00 UTC), copied off-site
0 21 * * * cd /opt/restraunt-erp && docker compose -f ops/production/docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -U ros -Fc restaurant_os' > /var/backups/ros/restaurant_os-$(date -u +\%Y\%m\%dT\%H\%M\%SZ).dump 2>>/var/log/ros-backup.log
```

Alternatively, install `postgresql-client-16` and the AWS CLI on the host and run `ops/backup/backup.sh` directly. That script also verifies the dump, archives receipts, uploads to S3 and prunes old copies. [backup-restore.md](backup-restore.md) has both variants.

## 3. Files: local volumes or S3

There are two kinds of files:

- **Product images** are public menu content. With `STORAGE_DRIVER=local` they are served from `/uploads`. With `s3` they get a public URL under `S3_PUBLIC_BASE_URL`.
- **Expense receipts** are private financial documents. They are never served as static files.
  - With `local` storage they live in `PRIVATE_UPLOAD_DIR` (the `uploads_private` volume).
  - With `s3` they go to the same bucket, marked `private, no-store`.
  - The only way to open a receipt is `GET /api/v1/expenses/:id/receipt`. This checks the user's permission, then streams the file or redirects to a signed S3 link that expires after `S3_PRESIGN_SECONDS` (default 300 seconds).

For S3, keep the bucket private, and allow public reads only on the image prefixes (`*/products/*`), for example with a bucket policy or a CDN in front. Never make `*/receipts/*` public.

## 4. Managed cloud (several API instances)

The API is stateless:

- Sessions are in PostgreSQL.
- Rate-limit counters are in Redis.
- Realtime events go through the PostgreSQL outbox, so any instance can serve any socket.

To run it this way:

- **Image:** build `docker build -f apps/api/Dockerfile -t <registry>/restaurant-os-api:<version> .` and push it.
- **Migrations:** run `npx prisma migrate deploy && node dist-seed/prisma/seed.js` as a one-off release task before new instances start, as the `migrate` service does.
- **PostgreSQL 16:** for example AWS RDS or Aurora in `ap-south-1`. Turn on automated backups with point-in-time recovery, and set `DATABASE_URL`, adding `&connection_limit=10` per instance.
- **Redis 7:** for example ElastiCache or Upstash. Set `REDIS_URL`. Redis only holds rate-limit counters; losing it loses nothing else.
- **Storage:** set `STORAGE_DRIVER=s3` and the `S3_*` settings.
- **Load balancer:** terminate TLS and forward `X-Forwarded-For` and `X-Forwarded-Proto`. Set `TRUST_PROXY=true`, and enable sticky sessions or WebSocket support for `/realtime`.
- **Health checks:** liveness is `GET /api/v1/health/live`; readiness is `GET /api/v1/health/ready`. Readiness fails only when PostgreSQL is down. A Redis outage is reported as `degraded`, and the instance keeps serving.

## 5. Go-live checklist

- [ ] `health/ready` returns `ok` over HTTPS, and the certificate is valid.
- [ ] A password-reset email reaches a real inbox.
- [ ] The first backup has run, and a test restore into a scratch database worked ([backup-restore.md](backup-restore.md)).
- [ ] Prometheus is scraping `/api/v1/metrics`, and a test alert reaches the on-call phone ([monitoring.md](monitoring.md)).
- [ ] `SEED_DEMO=false`. Roles reviewed: only the people who should can give discounts, refunds, cancellations and price changes ([admin-guide.md](admin-guide.md)).
- [ ] GSTINs, state codes and invoice prefixes are set for every branch ([admin-guide.md](admin-guide.md)).
- [ ] The server firewall allows only ports 22, 80 and 443.
