# Self-hosting ARIA

Run the entire ARIA stack on your own machine with Docker Compose: the ARIA
server (edge + internal API), PostgreSQL, and Redis. Nothing leaves the host.

This is the right setup for evaluating ARIA privately, for air-gapped or
on-prem deployments, and for putting a trust layer in front of a **local agent**
(for example a desktop assistant) without sending its activity to the cloud.

> **What self-hosting changes about the trust model.** When you run ARIA
> locally, you also control its database. The event log is still append-only at
> the database level, but a host operator who controls Postgres could in
> principle tamper with it. So a fully local instance gives you a strong
> *internal* audit trail and live guardrails (scope enforcement, the gate), but
> not the "independent third party" guarantee you get from the hosted service.
> The planned hybrid mode — keep raw events local, push only Merkle roots to the
> cloud as a notarized anchor — is what restores external verifiability without
> giving up privacy.

## Prerequisites

- Docker and Docker Compose v2 (`docker compose version`).
- `openssl` (or any way to generate random hex) for the two secrets below.

## 1. Configure

From the repo root:

```bash
cp .env.docker.example .env
```

Generate and fill in the two required secrets in `.env`:

```bash
# SETUP_KEY — protects the bootstrap endpoint. Any long random string.
openssl rand -hex 24

# ENCRYPTION_KEY — AES-256-GCM key. MUST be exactly 64 hex chars (32 bytes).
openssl rand -hex 32
```

For anything beyond local dev, also change `POSTGRES_PASSWORD`.

## 2. Start

```bash
docker compose up -d
```

This builds the server image, starts Postgres and Redis, runs the database
migrations once (idempotent — safe to leave running on every `up`), then starts
ARIA. Check it is healthy:

```bash
docker compose ps
curl http://localhost:8080/health
# {"status":"ok","db":"connected",...}
```

The public API is now at `http://localhost:8080`. The internal API stays bound
inside the container and is never exposed.

## 3. Bootstrap your first API key and agent

The first API key is created through the bootstrap endpoint, authorized by the
`SETUP_KEY` you set in `.env`:

```bash
curl -X POST http://localhost:8080/v1/setup \
  -H "Content-Type: application/json" \
  -d '{
    "setup_key": "PASTE_YOUR_SETUP_KEY",
    "owner_email": "you@example.com",
    "name": "my-first-agent",
    "scope": ["read:data", "send:email"]
  }'
```

The response contains your `api_key` and, because you passed `name` and `scope`,
a first `agent` with its `did` and `secret`. Save all three.

## 4. Point an SDK at your local instance

Just set the base URL to your local edge — everything else is identical to the
hosted product.

Python:

```python
from aria_sdk import ARIAClient

aria = ARIAClient(base_url="http://localhost:8080", api_key="YOUR_API_KEY")
agent = aria.register_agent(name="local-agent", scope=["read:data"])
aria.track(agent["did"], agent["secret"], "read:data", lambda: do_work())
```

TypeScript:

```typescript
import { createClient } from '@ariatrust-io/aria-sdk';

const aria = createClient({ baseUrl: 'http://localhost:8080', apiKey: 'YOUR_API_KEY' });
```

## Operating

```bash
docker compose logs -f aria      # tail the server logs
docker compose down              # stop (data is kept in named volumes)
docker compose down -v           # stop and DELETE all data (Postgres + Redis)
docker compose up -d --build     # rebuild after pulling new server code
```

Data persists in the `aria_pgdata` and `aria_redisdata` named volumes across
restarts.

## Notes and limits

- **Email, OAuth, and billing are optional and off by default.** OAuth buttons
  return 503 until you set the provider credentials; gate-approval emails are
  skipped unless `RESEND_API_KEY` is set. The core (identity, audit trail, trust
  score, scope enforcement, gate via dashboard/API) works without any of them.
- **`DB_SSL=false`** is set for the bundled Postgres, which has no TLS. If you
  point ARIA at an external managed Postgres that requires TLS, remove that or
  set it to anything other than `false`.
- **Migrations** apply in full to a fresh database. The bootstrap runner skips
  when the schema already exists; it does not yet upgrade an older schema in
  place.
