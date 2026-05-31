# ARIA Technical Documentation

This is the internal technical reference for the ARIA server. For the product overview and quickstart, see [README.md](README.md). For exact column definitions of any table, the source of truth is `server/src/db/schema.sql` plus the ordered files in `server/src/db/migrations/`.

## What ARIA is

ARIA is a Node and TypeScript service that provides trust and accountability for fleets of autonomous AI agents. It gives each agent a cryptographic identity, signs and stores every action in an immutable log, re checks each action against the agent's declared scope, can pause destructive actions for human approval, and computes a reputation score from verified behavior. It is a B2B SaaS product reached over an HTTPS API with an API key. There is no blockchain and no token.

A note on the enforcement model, since it shapes what the server here can and cannot promise. Scope enforcement and the human approval gate run client side, inside the SDK, before the wrapped function executes. The SDK fetches the agent scope (or opens a gate request and polls it) and throws before calling `fn()` when the action is out of scope, denied, or timed out, so the action never runs. The server's job is to be the source of truth the SDK checks against, to record every attempt including blocked ones, and to re verify scope independently on ingest (`server_within_scope`). The server does not execute or intercept agent actions itself. An action an agent takes without routing it through `track()` is not gated or scope checked; for that path ARIA's value is the audit trail and the independent re check at ingest, not prevention.

## Process topology

ARIA runs as two Node processes started together by `npm start` (via `concurrently`).

```
Internet
   |
[ Cloudflare ]
   |
[ membrane.ts ]   public edge, listens on PORT (default 8080) on 0.0.0.0
   |   - default-deny path allowlist (config/public-routes.ts)
   |   - edge rate limiting (200 req/min/IP)
   |   - scanner detection and temporary IP bans (Redis backed)
   |   - method allowlist (GET, POST, DELETE, OPTIONS)
   |   - proxies allowed requests to the internal API
   v
[ index.ts ]      internal API, listens on INTERNAL_PORT (default 3000) on 127.0.0.1
   |
[ PostgreSQL ]  +  [ Redis ]
```

The internal API is never exposed to the internet directly. It assumes every request reached it through the membrane.

### `src/membrane.ts` (public edge)

Responsibilities, in request order:

1. Block requests from IPs already banned (`membrane:blocked:<ip>` in Redis).
2. Detect scanner probes (paths like `/.env`, `/wp-admin`, `/phpmyadmin`). After `SCAN_THRESHOLD` (10) suspicious requests, the IP is banned for 24 hours.
3. Edge rate limit of 200 requests per minute per IP.
4. Reject any method outside GET, POST, DELETE, OPTIONS with 405.
5. Apply the path allowlist. If `isPublicPath(req.path)` is false, return 404 before reaching application code.
6. Proxy the request to `http://localhost:INTERNAL_PORT`.

On startup the membrane opens its HTTP port immediately, then polls the internal `/health` endpoint up to 30 times (once per second) before declaring the internal API ready. If the internal API never answers, the membrane keeps serving but logs a degraded state.

### `src/config/public-routes.ts` (the allowlist)

Single source of truth for which path prefixes the membrane forwards. It exports `PUBLIC_PATHS` and `isPublicPath(path)`. The matcher is precise: a path is public only if it exactly equals an allowed prefix or sits beneath it as `prefix/...`. So `/proof` allows `/proof` and `/proof/public/stats` but not `/proofXYZ`. `/` is special cased to an exact match so it never behaves as a catch all.

Adding an entry here is a deliberate decision to expose a path publicly. The guardrail test `src/tests/membrane.test.ts` fails the build if `PUBLIC_PATHS` changes without a matching update to the test manifest, so a new route can never be silently exposed or silently left unreachable (a 404 in production that still works locally because local testing hits the internal API directly).

### `src/index.ts` (internal API)

Configures Express, mounts every router, and starts the internal server. Notable points:

- Fatal `uncaughtException` and `unhandledRejection` handlers that log and exit the process. Railway restarts it.
- `helmet` security headers, `cors` restricted to `ALLOWED_ORIGINS`.
- The Lemon Squeezy billing webhook is mounted with a raw body parser before `express.json`, because signature verification needs the unparsed body.
- `express.json({ limit: "1mb" })` plus guards that reject non JSON content types and JSON nested deeper than 5 levels.
- A public `POST /v1/setup` endpoint to bootstrap the first API key and agent.
- A per IP API rate limiter (1500 req/min) backed by Redis where available.
- Final 404 and error handlers that always return JSON.

## Routers

All routers are mounted under `/v1` except the page routes and `/health`. Routes that require authentication use the `requireApiKey` middleware; feature gated routes also pass through `requireFeature(...)` from the plans middleware.

| Mount | File | Purpose |
|---|---|---|
| `/v1/setup` | `index.ts` | Bootstrap a first API key (and optionally a first agent) using `SETUP_KEY`. |
| `/v1/agents` | `routes/agents.ts` | Register, list, and fetch agents. |
| `/v1/events` | `routes/events.ts` | Ingest single and batch events, list events, export (CSV, JSON, OpenTelemetry). |
| `/v1/auth` | `routes/auth.ts`, `routes/oauth.ts` | Account login, 2FA, session, and OAuth (Google, GitHub). |
| `/v1/api-keys` | `index.ts` | Create and rotate API keys. |
| `/v1/webhooks` | `routes/webhooks.ts` | Register and manage outbound webhooks. |
| `/v1/gate` | `routes/gate.ts` | Human in the loop approval for gated actions. |
| `/v1/witness` | `routes/witness.ts` | Shadow Witness external cross verification. |
| `/v1/temporal` | `routes/temporal.ts` | Temporal anchors and per event seal verification. |
| `/v1/zeroproof` | `routes/zeroproof.ts` | Merkle backed proofs of behavior. |
| `/v1/admin` | `routes/admin.ts` | Administrative operations (tighter rate limit). |
| `/v1/billing` | `routes/billing.ts` | Lemon Squeezy checkout and webhook handling. |
| `/v1/proof` | `routes/proof.ts` | Public, read only, anonymized live proof for the demo agent. |
| `/proof`, `/`, `/app`, `/docs`, `/pricing`, legal pages | `index.ts` | Static HTML served from `src/public`. |
| `/health` | `index.ts` | Server and database health. |

### Agents (`routes/agents.ts`)

`POST /` registers an agent. Input is `name`, `scope` (array of `verb:resource` strings), an optional `hardwareFingerprint`, and optional `meta`. Two credential modes:

- **Classic (signing version 1).** No hardware fingerprint. The server generates a `secret`, stores its bcrypt hash and an encrypted HMAC key, and returns the secret to the client for signing.
- **DTS, distributed trusted signing (signing version 2).** A hardware fingerprint is provided. The master secret is split with Shamir's Secret Sharing (threshold 2 of 3). The server keeps a derived key part, the client receives its own key part, and a valid signature requires both parts to agree.

`GET /` lists the caller's agents with masked DIDs and summary stats. `GET /:did` returns full detail for one agent including reputation aggregates and top actions.

### Events (`routes/events.ts`)

The `IncomingEvent` shape: `eventId`, `agentDid`, `action`, `outcome` (`success`, `error`, `anomaly`, or `blocked`), `withinScope`, `durationMs`, `timestamp` (ISO 8601), `signature`, optional `error`, optional `meta`.

Ingestion steps for `POST /` and `POST /batch` (batch up to 500 events, all for the same agent):

1. Validate the event shape and reject timestamps skewed more than five minutes from now.
2. Look up the agent by DID, scoped to the caller's API key or user.
3. **Re check scope on the server.** The result is stored in `server_within_scope` regardless of what the agent reported in `withinScope`.
4. **Verify the signature.**
   - Version 1: HMAC-SHA256 over `eventId:agentDid:action:outcome:timestamp`, compared with a timing safe comparison.
   - Version 2: the server computes `partial_A` from its stored key part, takes `partial_B` from the event meta, then checks the event signature against `HMAC(partial_A || partial_B, "dts_binding")`. This is a key binding construction, not a plain XOR.
5. Apply a per agent rate limit (100 events per minute). Over the limit, events are still accepted but flagged in meta.
6. Detect anomalies (scope violation, signature failure, hardware fingerprint conflict, rate limit exceeded) and record them.
7. Insert into `events`, update the agent's `last_seen`, and queue a reputation recalculation.

Listing and export: `GET /` paginates with `limit` (max 100) and a `cursor`. `GET /export` produces CSV, JSON, or OpenTelemetry log format, filtered by agent and type, gated by the plan's `export` feature (the founder account is exempt).

Sensitive meta fields (hardware fingerprints, key parts, internal flags) are stripped before any event is returned through the API.

### Public live proof (`routes/proof.ts`)

A read only window onto one hardcoded demo agent, rate limited to 30 requests per minute per IP. Stats are cached for 60 seconds, the event list for 10 seconds. Every query selects only safe columns, so signatures, secrets, full DIDs, user ids, and payloads are never returned.

| Endpoint | Returns |
|---|---|
| `GET /public/stats` | Counters (total, success, error, gated, anomaly), agent age in days, latest seal root, and a real `sample_event_id` to try in the verifier. |
| `GET /public/events?limit=50` | Recent events, anonymized, max 100. |
| `GET /public/download/:type` | CSV of `good` (success), `bad` (error), or `gated` (out of scope) events, up to 50 rows. |
| `POST /public/verify` | Recomputes the hash of the given event id and checks it against the sealed anchor root. Returns `{ verified, root, timestamp, action }`. |

## Services

| File | Purpose |
|---|---|
| `services/reputation.ts` | Computes the trust score and maintains `reputation_snapshots`. Recalculation is debounced and batched. |
| `services/sync-public-reputation.ts` | Mirrors score and trust level into a public reputation table. |
| `services/anomaly-detector.ts` | Records anomalies (capped per agent), archives and cleans old ones. |
| `services/pattern-detector.ts` | ARIA Spectrum: turns raw anomalies into described behavioral patterns. |
| `services/temporal-anchor.ts` | Folds recent events into a running hash chain anchor and verifies individual events against it. |
| `services/shadow-witness.ts` | Cross checks agent reported counts against an external source. |
| `services/zeroproof.ts` | Builds Merkle backed proofs of behavior. |
| `services/webhook.ts` | Delivers outbound webhook notifications. |
| `services/oauth.ts` | OAuth flows for Google and GitHub. |
| `services/email.ts` | Transactional email through Resend. |

### Trust score (`services/reputation.ts`)

The score runs from 0 to 95 and is based on the last 30 days of behavior, across five rate based dimensions. Rate based means volume does not change the outcome: a million events at a 6% violation rate scores the same as a thousand events at the same rate.

| Dimension | Weight |
|---|---|
| Success rate | 40% |
| Scope compliance | 30% |
| Behavioral consistency | 15% |
| Clean history | 10% |
| Recent trend | 5% |

| Score | Level |
|---|---|
| 80 to 95 | TRUSTED |
| 50 to 79 | NEUTRAL |
| 0 to 49 | UNTRUSTED |

The score never reaches 100 by design. The behavior is locked in by `src/tests/scoring.test.ts`.

### Temporal anchoring and event sealing (`services/temporal-anchor.ts`)

Each event is hashed over `event_id:action:outcome:client_ts:signature:agent_id`. Anchoring folds the agent's recent event hashes into a running chain hash and stores the resulting `anchor_hash` in `temporal_anchors`, with per event proofs in `temporal_proofs`. To verify an event later, the stored record is rehashed and compared against the sealed proof. If any field of the record changed, the hashes diverge. The public verifier on `/proof` and `POST /v1/temporal/verify/:eventId` both use this mechanism. The `anchor_hash` is what the UI presents as the Merkle or seal root.

## Authentication (`middleware/auth.ts`)

API keys arrive as `Authorization: Bearer <key>`. Verification:

1. Check an in memory cache (5 minute TTL, capped at 10,000 entries) for an O(1) hit.
2. On a miss, compute the SHA-256 of the key and look it up by the `key_sha256` index, then confirm with a bcrypt comparison against `key_hash`. Double storage gives a fast index lookup plus a slow, safe verification.
3. A legacy slow path exists for old keys without a SHA-256, limited in scope to avoid abuse, and self heals matched keys by filling in their SHA-256.

The middleware attaches `apiKeyId` and `ownerEmail` to the request.

## Plans and billing (`config/plans.ts`, `middleware/plans.ts`, `routes/billing.ts`)

Plans are Free, Professional, Business, and Enterprise, each defining agent and monthly event limits, history retention, an overage rate, and a set of feature flags (gate, zeroproof, export, webhooks, batch events, spectrum, temporal anchor, shadow witness, api access). `requireFeature(name)` blocks a route when the caller's plan lacks that feature. Event counts are tracked per user against the monthly limit. Billing is handled by Lemon Squeezy: checkout links live on the pricing page, and a signature verified webhook updates the user's plan.

## Database

The base tables are defined in `src/db/schema.sql`. Everything added later lives in `src/db/migrations/`, applied in numeric order. The base file is the historical starting point and does not reflect later additions on its own, so always read the migrations alongside it.

Core tables from the base schema:

- **api_keys**: `id`, `key_hash` (bcrypt), `key_sha256` (fast lookup), `label`, `owner_email`, `created_at`, `revoked_at`.
- **agents**: `id`, `did`, `name`, `scope` (text array), `api_key_id`, `public_key`, `secret_hash`, `hmac_key` (encrypted), `meta`, `signing_version`, `created_at`, `last_seen`.
- **events**: `id`, `event_id`, `agent_id`, `action`, `outcome`, `within_scope`, `server_within_scope`, `duration_ms`, `signature`, `signature_valid`, `error`, `meta`, `recorded_at`, `client_ts`. The `outcome` check allows `success`, `error`, `anomaly`, and `blocked` (the last added in migration 022). Database rules turn any `UPDATE` or `DELETE` on this table into a no op, so history is append only at the database level.
- **anomalies**: `id`, `event_id`, `agent_id`, `action`, `detected_at`, `acknowledged`.

Feature tables added by migrations (see the named file for exact columns):

| Area | Migration |
|---|---|
| Users and accounts | `007_users.sql`, `012_agent_user_id.sql` |
| Anomaly archive | `008_anomalies_archive.sql` |
| Email verification | `009_email_verification.sql` |
| Webhooks | `010_webhooks.sql` |
| Reputation score columns | `011_reputation_score.sql` |
| Gate | `013_gate.sql` |
| Spectrum | `014_spectrum.sql` |
| Shadow Witness | `015_witness.sql` |
| Temporal anchors and proofs | `016_temporal.sql` |
| ZeroProof | `017_zeroproof.sql` |
| Admin | `018_admin.sql` |
| Password reset | `019_password_reset.sql` |
| OAuth | `020_oauth.sql` |
| Plans | `021_plans.sql` |
| Blocked outcome | `022_blocked_outcome.sql` |
| Billing | `023_billing.sql`, `024_billing_lemonsqueezy.sql`, `025_business_tier.sql` |

### Connection pool (`db/pool.ts`)

- `max`: configurable via `DB_POOL_MAX`, default 8 per instance.
- `statement_timeout`: 10 seconds.
- `idleTimeoutMillis`: 30 seconds.
- `connectionTimeoutMillis`: 2 seconds.
- `ssl`: in production, `{ rejectUnauthorized: false }` (Railway). Disabled locally.

`query(text, values)` runs a parameterized query. `transaction(fn)` wraps work in BEGIN, COMMIT, and ROLLBACK and always releases the client. `checkHealth()` returns whether the database is reachable.

## Security features

1. Default-deny public edge: only allowlisted paths are forwarded, scanners are detected and banned, and methods are restricted.
2. API key auth with SHA-256 fast lookup plus bcrypt verification, and timing safe failure handling.
3. HMAC-SHA256 event signatures with timing safe comparison, plus the version 2 key binding mode.
4. Server side scope re check that never trusts the agent's own claim.
5. Append only event log enforced by database rules.
6. AES-256-GCM encryption with context bound additional data for stored secrets.
7. Replay protection through a five minute timestamp window.
8. Redis backed rate limiting at the edge, on the API, and per agent.
9. Two factor authentication on accounts.
10. Parameterized SQL throughout.

## Environment variables

Required:

- `DATABASE_URL`: PostgreSQL connection string.
- `SETUP_KEY`: secret for the bootstrap endpoint. There is no default; the internal API refuses to start without it.
- `ENCRYPTION_KEY`: 32 byte hex key for AES-256-GCM.

Common:

- `PORT`: membrane external port, default 8080.
- `INTERNAL_PORT`: internal API port, default 3000.
- `NODE_ENV`: `development` or `production`.
- `ALLOWED_ORIGINS`: comma separated CORS allowlist.
- `APP_URL`: base URL used in emails and redirects.
- `REDIS_URL`: Redis connection string. If absent, rate limiters fall back to in memory counters.
- `DB_POOL_MAX`: pool size per instance, default 8.

Optional, feature dependent:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: OAuth. Buttons are visible but the endpoints return 503 if unset.
- `RESEND_API_KEY`: transactional email.
- Lemon Squeezy keys and webhook secret: billing.

## Local development

```bash
cd server
npm install
cp .env.example .env     # fill in DATABASE_URL, SETUP_KEY, ENCRYPTION_KEY
# apply src/db/migrations in order against your database
npm start                # runs the internal API and the membrane together
```

The public surface is the membrane port (`PORT`, default 8080). The internal API listens on `INTERNAL_PORT` (default 3000) bound to localhost. When testing through the public edge, send requests to the membrane port so the allowlist and rate limiting are exercised.

## Tests

```bash
npm test
```

The suite runs in this order: encryption helpers (`test:crypto`), HMAC signing (`test:hmac`), the public API contract against the live server (`test:api`), the trust score math (`test:scoring`), and the membrane allowlist with its anti drift guardrail (`test:membrane`).

## Technology stack

- Runtime: Node, TypeScript run directly through `tsx`.
- Framework: Express 5.
- Database: PostgreSQL via `pg`.
- Cache and rate limiting: Redis via `ioredis`.
- Cryptography: `crypto` (HMAC-SHA256, HKDF, AES-256-GCM), bcrypt, Shamir's Secret Sharing.
- Email: Resend. Billing: Lemon Squeezy.
- Hosting: Railway behind Cloudflare.
