# Security

Each item below says how RestaurantOS defends against a risk, and which test proves the defence works. The full requirements list is in [requirements-checklist.md](requirements-checklist.md).

## Accounts and sessions

| Risk | Defence | Proof |
|---|---|---|
| Stolen password database | Argon2id hashing (19 MiB memory, t=2), with a policy of 10–128 characters including a letter and a digit | `password.service.spec.ts` |
| Password guessing | Account lockout after `LOGIN_MAX_FAILED_ATTEMPTS` failures (state kept in PostgreSQL), plus a per-IP limit on auth routes. With several instances, the per-IP limit is shared through Redis. | auth e2e, `redis-throttler.storage.spec.ts` |
| Finding out which emails have accounts | Login, forgot-password and timing behave the same whether or not the email exists. The reset email is sent in the background, so a slow or failing mail server changes neither the answer nor the response time. | auth e2e |
| Stolen tokens | 15-minute access tokens. Refresh tokens rotate, and reusing one revokes the whole session family. Logout everywhere is available. | auth e2e |
| CSRF on cookie auth | `SameSite=Strict`, `Secure` and `HttpOnly` cookies, plus an Origin check on refresh | auth e2e |
| Weak production settings | The API refuses to start in production with `CORS_ORIGINS` set to `*`, `http://` or `localhost`, with insecure cookies, with the in-memory mail transport, with a non-HTTPS app URL, or with a placeholder JWT secret | `env.spec.ts` |

## Authorization and isolation

| Risk | Defence | Proof |
|---|---|---|
| Staff using functions outside their job | Deny by default. Every route declares the permission it needs and whether it applies to a branch or the whole organization. Roles are configurable. | `permissions.guard.spec.ts`, rbac e2e |
| Privilege escalation | Nobody can grant a permission they do not hold, or assign a role above their own | rbac e2e |
| One restaurant seeing another's data | Every query is scoped by organization. Composite foreign keys tie branch rows to their organization. Other organizations' ids return 404, never 403. | isolation e2e and every module suite |
| A branch manager seeing another branch | Permission checks are made per branch. Reports and dashboards include only the branches where the user holds the permission. | reports e2e, expenses e2e |
| Discounts, refunds and cancellations without approval | Separate permissions for each, a mandatory reason, and an audit log with before and after values | billing, orders and cash e2e |

## Money and records

| Risk | Defence | Proof |
|---|---|---|
| Changing a finalized invoice | Database triggers reject UPDATE and DELETE on finalized invoices, their lines, credit notes and every ledger table. Corrections go through credit notes. | `db-integrity.e2e-spec.ts`, billing e2e |
| Double charging on retries or double taps | Idempotency keys on every money-moving POST, row locks, and amounts checked against the outstanding balance inside the transaction | `critical-flows.e2e-spec.ts`, billing e2e |
| Gaps or duplicates in GST invoice numbers | Per-branch sequences, allocated inside the invoice transaction | critical-flows e2e (parallel trading in two branches) |
| Lost or disputed changes | Append-only `audit_logs` table: who, what, before and after, IP, user agent and request id | all suites |

## Files

| Risk | Defence | Proof |
|---|---|---|
| Uploading malware or HTML as an "image" | The file type is identified from its content (magic bytes), never from the name or Content-Type. Size limits apply. Files get random server-side names. | `image-validation.spec.ts`, menu and expenses e2e |
| Receipts readable by anyone with the link | Receipts are private. They are kept outside the public folder, and the public `/uploads` path refuses any `/receipts/` path, including files uploaded before this change. They are served only by `GET /expenses/:id/receipt` after a permission check, with `Cache-Control: private, no-store`, `nosniff` and a sandboxing CSP. On S3 that route redirects to a signed link that expires after 5 minutes. The storage key never leaves the server. | expenses e2e |

## Transport and headers

- **HTTPS everywhere.** Caddy or the load balancer terminates TLS and sends HSTS.
- **Helmet headers.** `X-Powered-By` is removed. JSON bodies are capped at 1 MB.
- **CORS** allows only the listed origins, with credentials.
- **Validation:** unknown fields are rejected, and every DTO has a whitelist.
- **Swagger** is off in production by default.
- **The metrics endpoint** needs a token (compared in constant time) and is blocked at the public proxy.
- **Logs** redact `Authorization`, cookies and `Set-Cookie`, and never contain email bodies.

## Operating it safely

- Keep secrets in `.env.production`, readable only by root (`chmod 600`), or in the platform's secret store. Never commit them.
- Rotate `JWT_ACCESS_SECRET` by deploying a new value. Everyone signs in again; refresh tokens are unaffected.
- Run `pnpm audit --prod` before each release. CI builds the production image on every change.
- Report vulnerabilities privately to the repository owner. Do not open a public issue.
