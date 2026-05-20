# Changelog

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
