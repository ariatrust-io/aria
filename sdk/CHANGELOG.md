# Changelog

## Python SDK 0.5.0 — Parity with TypeScript

The Python SDK (`aria_sdk.py`) was rewritten from a telemetry-only stub to full
parity with the TypeScript client.

- Stateless `ARIAClient(base_url, api_key)` — one instance tracks any number of agents
- `register_agent(name, scope)` returns `{did, secret, name, scope}`
- `track(agent_did, secret, action, fn, mode=..., gate=...)` wraps `fn()` and records the outcome
- Three modes: `light` (background, zero latency), `enforce` (blocking scope check, default), `gate` (human approval)
- Exceptions: `ScopeViolationException`, `GateDeniedException`, `GateBlockedException`, `GateTimeoutException`, `EventLimitException`
- Local scope cache (5-minute TTL); out-of-scope attempts recorded as `outcome: 'blocked'`
- `get_agent(did)`, `list_agents(name)`
- Installable via `pip install aria-sdk` (`pyproject.toml`)

DTS / signing version 2 is out of scope for this release, matching the TypeScript SDK (v1 HMAC only).

## 0.5.0 — Breaking Change

**Scope violations now block execution before fn() runs.**

- `ScopeViolationException` exported from main module — thrown when an action is not in the agent's declared scope
- Agent scope is fetched from server and cached locally (5-minute TTL) on first `track()` call
- `fn()` is **never called** for out-of-scope actions
- Blocked attempts are recorded to ARIA as `outcome: 'blocked'` (fire-and-forget, non-blocking)
- LangChain adapter (`wrapTool`, `wrapTools`) handles `ScopeViolationException` gracefully — returns descriptive string instead of throwing

**Migration guide:** catch `ScopeViolationException` anywhere you call `aria.track()` if you need custom handling. Without a catch block, the exception propagates up like any other error.

```ts
import { ScopeViolationException } from '@ariatrust-io/aria-sdk';

try {
  await aria.track(did, secret, 'delete_database', fn);
} catch (err) {
  if (err instanceof ScopeViolationException) {
    console.log(`Blocked: ${err.message}`);
    // fn() never ran
  }
}
```

## 0.4.0

- Gate mode with approval polling
- `GateDeniedException`, `GateBlockedException`, `GateTimeoutException`
- LangChain adapter (`wrapTool`, `wrapTools`, `createARIACallbackHandler`)
