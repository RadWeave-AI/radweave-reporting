# RadWeave Reporting

Standalone report-generation service. Called as a client by the RadWeave
website, RadWeave Desktop, and — later — hospital API customers.

Deployed to its own Vercel project ("RadWeave Reporting", Pro plan), separate
from the radmindai website project.

## Status

Auth, transport, validation, error handling, and all five report-generation
workflows are real and tested. The reporting kernel remains copied in both this
service and the website during the migration phase; the website has not been
switched to this service yet.

```
npm install
npm test          # unit + ported browser-generation suites; no network
npm run typecheck
npm run dev       # needs every variable in .env.example
```

## API

| Method | Path | Status |
|---|---|---|
| GET | `/v1/health` | live (public) |
| GET | `/v1/ready` | live (deep check, `DIAGNOSTICS_KEY` header) |
| GET | `/v1/credits` | live shape, stub balances |
| POST | `/v1/reports/checklist` | real generation |
| POST | `/v1/reports/quick` | real generation |
| POST | `/v1/reports/comparison` | real generation |
| POST | `/v1/reports/my-template` | real generation + JWT-scoped retrieval |
| POST | `/v1/reports/template-guided` | real generation |
| POST | `/v1/reviews/consultant` | reserved — returns 501 |

### Authentication

Two schemes, one `Principal`. Identity is always derived from the credential,
never from the request body.

```
Authorization: Bearer <supabase-jwt>      → UserPrincipal   (works today)
Authorization: ApiKey <key-id>.<secret>   → OrgPrincipal    (scaffolded, 501)
```

The Bearer path validates the token directly against Supabase Auth with
`getUser(token)` — cookie-free, so the website (server-side) and Desktop use
the identical mechanism. Desktop needs no new credential type.

`getUser(token)` is always a network call: `@supabase/auth-js` has no local
verification path. So "this token is bad" and "we never reached Supabase"
arrive as the same return value, and are told apart before either is reported:

| Failure | Caller sees | Server log |
|---|---|---|
| `exp` has passed | 401, "has expired … obtain a fresh access token" | cause |
| token rejected, our key accepted | 401, "is not valid" | cause |
| Supabase unreachable, our anon key rejected, client unbuildable | **503** `service-unavailable` | full cause at error level |

The 503 case is the important one. A token this service could not *check* has
told us nothing about the credential, so answering 401 blames the caller for
our own misconfiguration — that mistake cost three multi-hour debugging
cycles. The underlying `name | status | code | message | cause` is written to
the runtime log with the request id on every failure; the caller never sees a
hostname, a key, or an upstream message.

### Readiness

`/v1/health` is liveness only: public, fast, no network calls (503 if
configuration failed to load, so a broken deploy is never a green 200).

`/v1/ready` proves the credentials actually work — one real, cheap, read-only
call each to Supabase Auth via the anon key, Supabase service-role against
`subscriptions`, and Anthropic's `models.list` (free; no generation is
billed). It reports per-dependency status with the specific cause.

```bash
curl -H "X-Diagnostics-Key: $DIAGNOSTICS_KEY" https://<host>/v1/ready
```

Guarded by a dedicated `DIAGNOSTICS_KEY` header rather than a Bearer token, on
purpose: the endpoint exists to diagnose a broken auth path, so gating it
behind that path would make it useless exactly when it is needed. A missing or
wrong key answers **404**, identical to any unknown route, so the endpoint
cannot be found by probing; with `DIAGNOSTICS_KEY` unset it does not exist.
Output carries presence booleans and the Supabase *hostname* — never a secret.

A deployment whose configuration fails to load boots into diagnostics-only
mode rather than throwing at import time. `loadConfig` still fails loudly, but
a Vercel function that throws at module scope answers every request with an
opaque platform error naming nothing; this way `/v1/ready` names the missing
variable. `src/bootstrap.ts` is the single wiring path for both entry points.

**Still missing for the ApiKey path:** an `api_clients` table (key id, secret
hash, org id, plan, scopes, revoked-at), key issuance/revocation, constant-time
secret comparison, and per-org rate limiting and credit accounting — both of
which are keyed by user id today. Until that exists the scheme returns
`not-implemented` rather than pretending to reject a valid credential.

### Transport

One handler per workflow; the wire format is chosen at the edge from `Accept`:

```
Accept: text/event-stream   → SSE: event: delta | done | error
anything else               → a single JSON body
```

A workflow emits events and never knows which transport it is on. The website
currently has two divergent implementations of this (its SSE route and its
Desktop route evolved separately); collapsing them is the point.

### Error envelope

Every failure, in both transports:

```json
{ "ok": false, "error": "<category>", "message": "...", "request_id": "...",
  "retry_after_seconds": 30 }
```

| Category | Status |
|---|---|
| `validation-error` | 400 |
| `unauthorized` | 401 |
| `insufficient-credits` / `upgrade-required` | 403 |
| `not-found` | 404 |
| `aborted` | 499 |
| `rate-limited` | 429 |
| `internal-error` | 500 |
| `not-implemented` | 501 |
| `provider-error` | 502 |
| `service-unavailable` | 503 |
| `timeout` | 504 |

Pre-flight failures (auth, validation, rate limit, credits) are HTTP errors in
both transports. Only a mid-generation failure — after a 200 is already
committed — becomes an in-band `error` event.

### Request policy

Every reporting endpoint enforces a strict field allowlist plus an explicit PHI
denylist checked first, so a caller sending `patient_name` is told exactly
which field was rejected. `user_id` and `org_id` are also prohibited: a caller
may not assert whose report this is.

## Deployment notes

`api/index.ts` must default-export **an object with a `fetch` method** —
Vercel's Web Standard export for Node.js functions in `/api`. A bare
default-exported function is invoked as a Node-style `(req, res)` handler, so
its returned `Response` is discarded and the socket never closes: every request
then hangs until the duration limit. For the same reason, do not use `handle`
from `hono/vercel` here — that adapter targets Next.js App Router and Edge.
`test/vercel-entry.test.ts` pins this.

The local dev server is `src/dev-server.ts`, deliberately **not** `server.ts`:
Vercel captures a root- or `src/`-level `server.{ts,js,…}` that calls
`server.listen()` at startup and deploys it as the HTTP server, which would
compete with `api/index.ts` for the same traffic.

`maxDuration` is **300s**. Real generation includes streamed provider calls and
Template-guided can perform a second correction call, so the stub-era 60s cap
could terminate a valid report mid-stream. Vercel Fluid Compute defaults to
300s; Pro can be configured higher if production measurements justify it.

## Layout

```
api/index.ts              Vercel entry (hono/vercel, Node runtime)
src/dev-server.ts         local dev server (@hono/node-server)
src/bootstrap.ts          the single wiring path for both entry points
src/app.ts                routes, auth middleware, error mapping
src/config.ts             fail-loud env loading (no .env.local fallback)
src/auth/principal.ts     Principal / AuthResult types
src/auth/resolve-caller.ts  the single authentication entry point
src/auth/auth-error.ts    auth error detail + failure classification
src/health/readiness.ts   live per-dependency credential checks
src/http/errors.ts        error categories, status map, envelope
src/http/transport.ts     Accept-driven SSE vs blocking dispatch
src/workflows/types.ts    transport-neutral workflow contract
src/workflows/request.ts  allowlist + PHI denylist validation
src/workflows/real.ts     five real workflow adapters
src/workflows/stub.ts     transport-only test fixture
src/lib/                  copied reporting kernel and dependencies
```

## Deferred deliberately

- Real generation (later mission — copy the workflow modules in)
- Credits, rate limiting, plan/entitlement enforcement
- `api_clients` and the ApiKey path
- Consultant Review (Phase D; URL reserved so v1 does not break)
