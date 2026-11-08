# Monitoring and alerts

## What the API exposes

| Endpoint | Who | Use |
|---|---|---|
| `GET /api/v1/health/live` | public | The process is up. Use it for container liveness. |
| `GET /api/v1/health/ready` | public | PostgreSQL answers, and Redis is reported. Returns 503 only when the database is down. |
| `GET /api/v1/metrics` | Bearer `METRICS_TOKEN` | Prometheus metrics. Off when `METRICS_TOKEN` is unset. Blocked at the public proxy. |

### Metrics

| Metric | Meaning |
|---|---|
| `ros_http_requests_total{method,route,status}` | Requests per route **template**, such as `/api/v1/orders/:id`, never per raw URL. Unknown paths are counted as `route="unmatched"`. |
| `ros_http_request_duration_seconds_bucket{method,route,status}` | Latency histogram, with buckets from 10 ms to 10 s. |
| `ros_database_up` | 1 when PostgreSQL answers. |
| `ros_redis_up` | 1 when Redis answers. Absent when Redis is not configured. |
| `ros_realtime_outbox_backlog` | Kitchen and POS events committed but not yet pushed to screens. It should stay near 0. |
| `ros_process_*`, `ros_nodejs_*` | Memory, CPU, event-loop lag, garbage collection and handles for each instance. |

## Logs and error tracking

The API writes one JSON line per request (pino). Each line has a `requestId`, which is also returned in the `X-Request-Id` header and in every error body, so a cashier's error screen can be matched to the exact log line. Authorization headers and cookies are redacted.

- **Unhandled errors inside a request** are logged with their stack by the global exception filter. The client gets a generic 500 with the `requestId`.
- **Errors outside requests** (`unhandledRejection`) are logged as `Unhandled promise rejection`.
- **An `uncaughtException`** is logged as fatal. The process then closes cleanly and exits, so Docker or the orchestrator restarts it.
- **Mail delivery failures** are logged with the recipient and subject, never the body, because the body can hold a reset link.
- **A Redis outage** is logged once a minute while it lasts.

Ship container logs to any JSON log store, such as Grafana Loki, CloudWatch Logs or Better Stack. Alert on `level >= 50` (error) bursts and on any `level == 60` (fatal).

## Prometheus and alerts

`ops/monitoring/prometheus.yml` scrapes each API instance on the private network. `ops/monitoring/alerts.yml` defines these alerts:

| Alert | Fires when | Severity |
|---|---|---|
| `ApiDown` | An instance has not answered for 2 min | critical |
| `DatabaseUnreachable` | PostgreSQL has been down for 1 min | critical |
| `HighErrorRate` | More than 2% of requests return 5xx, over 5 min | critical |
| `SlowCheckout` | p95 of checkout and payment is above 1.5 s, for 10 min | warning |
| `RealtimeBacklog` | More than 500 unpublished events, for 5 min | warning |
| `RedisDown` | Redis has been unreachable for 5 min | warning |
| `HighMemory` | An instance uses more than 1.5 GB, for 15 min | warning |
| `EventLoopLag` | p99 event-loop lag is above 0.5 s, for 10 min | warning |

To add Prometheus to the one-server stack:

1. Put the token in `ops/monitoring/metrics-token`, readable only by root.
2. Run `prom/prometheus` on the `backend` network, with `ops/monitoring` mounted at `/etc/prometheus`.
3. Route alerts through Alertmanager to email, Slack or PagerDuty.

Grafana Cloud's free tier can also scrape with the same config through Grafana Alloy.

## Runbooks

### API down
1. Run `docker compose -f ops/production/docker-compose.prod.yml ps`. Look for a restart loop.
2. Read the last fatal or error lines in `docker compose logs --tail=200 api`.
3. If it exited on a config error, the message names the setting. Fix `.env.production` and run `up -d`.
4. If it was killed for memory (`OOMKilled` in `docker inspect`), raise the memory limit and look at `HighMemory` history.

### Database unreachable
1. Run `docker compose ps postgres`, then `docker compose logs postgres`.
2. Check the disk: `df -h`. A full disk is the usual cause, and backups in the same filesystem fill it fastest.
3. Once the database is back, the API recovers on its own; there is nothing to restart. Check that `ros_realtime_outbox_backlog` drains.

### High error rate
1. Group 5xx by route: `sum by (route) (rate(ros_http_requests_total{status=~"5.."}[5m]))`.
2. Take a `requestId` from the logs for that route and read the stack.
3. If it started with a deploy, roll back ([deployment.md](deployment.md)).

### Slow requests
1. Check `histogram_quantile(0.95, sum by (le, route) (rate(ros_http_request_duration_seconds_bucket[5m])))` to find the slow route.
2. Event-loop lag means CPU-bound work, such as a very large PDF export. Database time shows in PostgreSQL: `SELECT * FROM pg_stat_activity WHERE state <> 'idle'`.
3. Baselines for comparison are in [performance.md](performance.md).

### Realtime backlog
Kitchen screens stop updating, but orders and bills still work.
1. Check `REALTIME_ENABLED` and the logs for `Realtime` errors.
2. A long-running transaction can hold the relay back. Look for `idle in transaction` in `pg_stat_activity`.
3. Clients catch up from the outbox on reconnect; no events are lost.

### Redis down
Rate limits are not enforced while Redis is down. Login brute force is still stopped by the account lockout in PostgreSQL. Restart Redis; there is no data to recover.

### High memory
Find which instance is affected and whether the growth is steady (a leak) or tied to exports. Restart that instance, then open an issue with a heap snapshot (`node --inspect`) if the growth is steady.
