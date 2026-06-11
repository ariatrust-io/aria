# ARIA Python SDK

Official Python SDK for [ARIA](https://ariatrust.org) — trust infrastructure
for AI agents. Functional parity with the TypeScript SDK.

## Install

```bash
pip install aria-sdk
```

## Quick start

```python
from aria_sdk import ARIAClient

aria = ARIAClient(base_url="https://ariatrust.org", api_key="YOUR_API_KEY")

# Register an agent — save the did and secret.
agent = aria.register_agent(name="my-agent", scope=["read:data", "send:email"])
print(agent["did"])     # did:agentrust:...
print(agent["secret"])  # keep this secret

# Track an action. fn() runs only if the action is within scope.
result = aria.track(
    agent["did"], agent["secret"], "read:data",
    lambda: fetch_user_data(user_id),
)
print(result.value)  # whatever fn() returned
```

## Modes

```python
# Light — fire and forget, zero added latency.
aria.track(did, secret, "read:data", fn, mode="light")

# Enforce (default) — blocking scope check before fn() runs.
aria.track(did, secret, "read:data", fn)

# Gate — require human approval before executing.
from aria_sdk import GateDeniedException

try:
    aria.track(
        did, secret, "delete:records", fn,
        mode="gate",
        gate={
            "requireApproval": ["delete:*"],
            "autoBlock": ["drop:*", "truncate:*"],
            "timeoutMs": 5 * 60 * 1000,
        },
    )
except GateDeniedException:
    print("Owner denied — action blocked")
```

## Exceptions

| Exception | Raised when |
|---|---|
| `ScopeViolationException` | The action is outside the agent's declared scope. `fn()` never runs. |
| `GateBlockedException` | The action matches an `autoBlock` pattern. `fn()` never runs. |
| `GateDeniedException` | The owner denied the gated action. `fn()` never runs. |
| `GateTimeoutException` | No approval arrived before `timeoutMs`. `fn()` never runs. |
| `EventLimitException` | The plan's monthly event limit was reached. |

## License

BUSL-1.1
