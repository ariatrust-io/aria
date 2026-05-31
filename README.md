# ARIA

**Your AI agents take real actions. Can you prove what they did?**

ARIA is trust and accountability infrastructure for fleets of autonomous AI agents. It gives every agent a cryptographic identity, an immutable audit trail, a live trust score based on real behavior, and a human approval gate that can stop a destructive action before it runs.

It is a normal B2B SaaS product. You talk to it over an HTTPS API with an API key, you watch your agents from a web dashboard, and you pay a monthly subscription. There is no blockchain, no token, and no wallet. Just an API, a database, and a dashboard.

[![npm](https://img.shields.io/npm/v/@ariatrust-io/aria-sdk)](https://www.npmjs.com/package/@ariatrust-io/aria-sdk)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](LICENSE)

## See it working on real data

Before reading another word, look at a real agent under ARIA, with live and verifiable data:

**[ariatrust.org/proof](https://ariatrust.org/proof)**

That page shows tens of thousands of real actions from a production agent: successes, errors, and actions ARIA blocked. You can download the logs as CSV and paste any event ID into the verifier to recompute its cryptographic seal yourself. Nothing on that page is mocked.

## The problem ARIA solves

An autonomous agent can delete a production database, move money, or touch customer records, and then report whatever it wants about what it did. When something goes wrong at scale, across thousands of agents making decisions on their own, the hard question is not "what is my agent allowed to do". The hard question is "what did it actually do, and can I prove it to an auditor, a regulator, or a customer".

ARIA answers that question with four things working together:

1. **Identity.** Every agent gets an unforgeable decentralized identifier (`did:agentrust:...`).
2. **Sealed audit trail.** Every action is signed and written to an append only log that cannot be edited or deleted, then sealed into a hash chain.
3. **Enforcement.** ARIA checks each action against the scope the agent was declared with, and can pause destructive actions for human approval.
4. **Reputation.** Each agent earns a trust score from its verified behavior over time.

## Quickstart (using ARIA in your app)

```bash
npm install @ariatrust-io/aria-sdk
```

```typescript
import { createClient } from '@ariatrust-io/aria-sdk';

const aria = createClient({ apiKey: process.env.ARIA_API_KEY });

// Register your agent once. The scope is the list of actions it is allowed to do.
const agent = await aria.registerAgent({
  name: 'invoice-processor',
  scope: ['read:invoices', 'send:email', 'write:database']
});

// Wrap any action in one line. ARIA signs it, checks scope, and records it.
await aria.track(agent.did, agent.secret, 'read:invoices',
  () => fetchInvoices()
);
```

After that, the agent has a cryptographic identity, an immutable record of every action, a trust score that updates in real time, and automatic scope enforcement.

### Stop destructive actions before they happen

```typescript
import { GateDeniedException } from '@ariatrust-io/aria-sdk';

try {
  await aria.track(
    agent.did,
    agent.secret,
    'delete:records',
    () => deleteRecords(ids),
    { mode: 'gate' }
  );
} catch (err) {
  if (err instanceof GateDeniedException) {
    console.log('Owner denied the action. Records are safe.');
  }
}
```

When a gated action fires, execution pauses immediately, the owner gets a notification, and nothing runs until a human approves or denies it from the dashboard. If there is no response within five minutes, the action is denied by default.

A note on how enforcement actually works, because this is security infrastructure and the distinction matters. The block happens inside the SDK, in your agent's own process: `track()` runs the scope check and the gate *before* it ever calls your function, so a denied or out-of-scope action never executes. That is real pre-execution prevention, not after-the-fact detection. But it is cooperative. ARIA enforces the actions you route through the SDK in `enforce` or `gate` mode. It is not a network-level kill switch that can stop an agent from doing something it never wrapped with `track()`. For anything outside that wrapper, ARIA's guarantee is the audit trail: it records and can flag what happened, but it did not stand in front of it. The `light` mode is detection only by design, running the scope check in the background so it adds no latency while your function runs regardless.

### LangChain

```typescript
import { wrapTools } from '@ariatrust-io/aria-sdk/langchain';

const tools = wrapTools(
  [searchTool, calculatorTool, emailTool],
  aria,
  { agentDid: agent.did, secret: agent.secret }
);
```

Every tool call is tracked automatically. No other changes to your agent code are needed.

## How it is built

ARIA runs as two processes that talk over localhost.

```
Internet
   |
[ Cloudflare ]
   |
[ membrane.ts ]      public edge on port 8080
   |  default-deny path allowlist (config/public-routes.ts)
   |  rate limiting, scanner blocking, IP bans
   v
[ index.ts ]         internal API on port 3000, never exposed directly
   |
[ PostgreSQL ]  +  [ Redis ]
```

**The membrane** is the only thing the public can reach. It forwards a request to the internal API only if the path is on an explicit allowlist, and rejects everything else with a 404 before it touches application code. The allowlist lives in one file, `server/src/config/public-routes.ts`, and a test in `server/src/tests/membrane.test.ts` fails the build if a route is exposed or removed without a matching, reviewed change. That turns "I forgot to expose a new route" into a loud test failure instead of a silent production 404.

**The internal API** holds all the real logic: agents, events, gating, scoring, billing, and the rest. It assumes it is never reached except through the membrane.

Stack: Node with TypeScript (run directly through `tsx`), Express 5, PostgreSQL through `pg`, Redis through `ioredis`, deployed on Railway behind Cloudflare. Payments run through Lemon Squeezy. The web dashboard and landing pages are plain HTML served from `server/src/public`.

### Repository layout

```
server/        Express API, membrane, dashboard, landing pages
  src/
    index.ts             internal API entry
    membrane.ts          public edge / proxy
    config/              plans, public route allowlist
    routes/              agents, events, gate, proof, billing, ...
    services/            reputation, anomaly detection, temporal anchor, ...
    db/                  pool, schema.sql, migrations/
    public/              landing, dashboard, /proof, legal pages
    tests/               crypto, hmac, api, scoring, membrane
sdk/           TypeScript SDK published as @ariatrust-io/aria-sdk
simulator/     load and behavior simulator used to generate demo traffic
```

## How the cryptography actually works

Nothing here requires you to trust ARIA's word. Each piece is independently checkable.

**Signed events.** Each event is signed with the agent's HMAC key over a fixed payload (event id, agent DID, action, outcome, timestamp). The server verifies the signature with a timing safe comparison. There is also a stronger split key signing mode (version 2) where the final signature only validates if both a server side key part and a client side key part agree.

**Server side scope check.** The agent reports whether an action was in scope, but the server does not trust that flag. It re checks the action against the scope stored in the database and records its own verdict in `server_within_scope`. An action outside scope is flagged no matter what the agent claimed.

**Immutable log.** The `events` table has database rules that turn any `UPDATE` or `DELETE` into a no op. History cannot be rewritten, even by the application.

**Temporal anchors.** Periodically ARIA folds an agent's recent events into a running hash chain and stores the resulting anchor hash. To verify an event later, ARIA recomputes its hash from the stored record and checks it against that sealed anchor. If a single byte of the record were altered, the hashes would no longer match. This is exactly what the public verifier on `/proof` does.

## Public live proof API

A read only, anonymized view of one demo agent, hardcoded to a single identity and rate limited to 30 requests per minute per IP. Every query selects only safe columns, so signatures, secrets, full DIDs, user ids, and payloads are never returned.

| Endpoint | Returns |
|---|---|
| `GET /v1/proof/public/stats` | Aggregate counters, agent age, latest seal root, and a sample event id to try |
| `GET /v1/proof/public/events?limit=50` | Recent events, anonymized |
| `GET /v1/proof/public/download/:type` | CSV of `good`, `bad`, or `gated` events (up to 50 rows) |
| `POST /v1/proof/public/verify` | Recomputes an event hash and checks it against the sealed root |

## Trust Score

Every agent gets a score from 0 to 95 based on its last 30 days of behavior, across five dimensions, all rate based rather than count based.

| Dimension | Weight |
|---|---|
| Success rate | 40% |
| Scope compliance | 30% |
| Behavioral consistency | 15% |
| Clean history | 10% |
| Recent trend | 5% |

Because the dimensions are rate based, an agent with a million events and a 6% violation rate scores the same as one with a thousand events at the same rate. Volume does not inflate the penalty. The score never reaches a perfect 100, because perfect certainty is not something this system claims to offer.

| Score | Level |
|---|---|
| 80 to 95 | TRUSTED |
| 50 to 79 | NEUTRAL |
| 0 to 49 | UNTRUSTED |

## Plans

| | Free | Professional | Business | Enterprise |
|---|---|---|---|---|
| Agents | 1 | 5 | 20 | Unlimited |
| Events / month | 50,000 | 500,000 | 5,000,000 | 50M+ |
| History | 30 days | 12 months | 12 months | Unlimited |
| ARIA Gate, ZeroProof, Export | no | yes | yes | yes |
| Price | Free | $49/mo | $149/mo | From $599/mo |

Full and current pricing lives at [ariatrust.org/pricing](https://ariatrust.org/pricing).

## More capabilities

<details>
<summary>ARIA Spectrum: behavioral pattern detection</summary>

Instead of a bare "anomaly detected", ARIA describes the pattern in plain language, for example: your agent attempts `delete:records` outside its declared scope between 11pm and 1am, 8 times in 7 days, which looks like a bug in a nightly cron job. It detects repeated action failures, time of day clustering, repeated scope violations, and sudden frequency spikes that suggest a runaway loop.

</details>

<details>
<summary>ZeroProof: prove behavior without revealing data</summary>

```bash
POST /v1/zeroproof/innocence    # prove an agent never ran a forbidden action
POST /v1/zeroproof/consistency  # prove a success rate stayed above a threshold
POST /v1/zeroproof/limits       # prove a rate limit was never exceeded
```

Each proof is backed by a Merkle commitment that an external auditor can check without access to your system.

</details>

<details>
<summary>Shadow Witness: external cross verification</summary>

Register an outside source to check what your agent reports against what actually happened. If the agent says it sent 100 emails but your email provider reports 47, ARIA flags the discrepancy.

```bash
POST /v1/witness/sources      # register an external source
POST /v1/witness/confirm/:id  # submit the external count
```

</details>

<details>
<summary>SIEM export (OpenTelemetry)</summary>

```bash
GET /v1/events/export?format=otel&agentDid=did:agentrust:...
```

Each event becomes an OpenTelemetry log record with typed attributes (agent DID and name, action, outcome, in scope flag, signature validity, duration, trust score at export). Severity maps as success to INFO, blocked to WARN, error and anomaly to ERROR. Works with any OTEL capable destination, including Splunk, Datadog, AWS CloudWatch, Grafana Loki, and Elastic.

</details>

## Running it locally

You need Node 20+, a PostgreSQL database, and optionally Redis (the rate limiters fall back to memory if Redis is absent).

```bash
cd server
npm install
cp .env.example .env        # then fill in DATABASE_URL, SETUP_KEY, and the rest
# apply the SQL in src/db/migrations in order against your database
npm start                   # runs the internal API and the membrane together
```

`npm start` launches `index.ts` and `membrane.ts` side by side. The public surface is the membrane port (`PORT`, default 8080), and the internal API listens on `INTERNAL_PORT` (default 3000) bound to localhost.

### Tests

```bash
npm test
```

The suite covers HMAC signing, the encryption helpers, the trust score math, the public API contract against the live server, and the membrane route allowlist (including the guardrail that prevents silent route exposure or removal).

## Security

- AES-256-GCM encryption with context bound additional data
- HMAC-SHA256 signatures with timing safe comparison, plus an optional split key signing mode
- Append only event log enforced at the database level
- Two factor authentication on accounts
- Redis backed rate limiting at both the edge and per agent
- Replay protection with a five minute timestamp window
- A default-deny public edge that blocks and bans scanners

Report a security issue to dhdez3149@gmail.com.

## Status

In production at [ariatrust.org](https://ariatrust.org). Shipped so far: DID identity, HMAC signing, immutable audit trail, trust score, dashboard with 2FA, webhooks, ARIA Gate, ARIA Spectrum, Shadow Witness, Temporal Anchor, ZeroProof with Merkle commitments, subscription billing, and the public live proof page. On the roadmap: zk-SNARK backed proofs, a Python SDK, a Go SDK, and SOC 2 Type II.

## Links

- Website: https://ariatrust.org
- Live proof: https://ariatrust.org/proof
- Dashboard: https://ariatrust.org/app
- Docs: https://ariatrust.org/docs
- npm: https://www.npmjs.com/package/@ariatrust-io/aria-sdk

## License

BUSL-1.1. Free for non production use. Contact dhdez3149@gmail.com for commercial licensing.
