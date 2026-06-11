# type: ignore
"""
SDK oficial de Python para ARIA — Trust Infrastructure for AI Agents.

Paridad funcional con el SDK de TypeScript (@ariatrust-io/aria-sdk):
registro de agentes, firma HMAC de cada accion, y `track()` con tres modos:

  - light   : fire-and-forget, latencia cero. El chequeo de scope corre en
              segundo plano y nunca bloquea a fn().
  - enforce : (por defecto) chequeo de scope ANTES de ejecutar fn(). Si la
              accion esta fuera del scope declarado, lanza ScopeViolationException
              y fn() nunca corre.
  - gate     : ademas del chequeo de scope, pide aprobacion humana antes de
              ejecutar. Bloquea hasta que el owner aprueba/deniega o expira.

Uso:

    from aria_sdk import ARIAClient

    aria = ARIAClient(base_url="https://ariatrust.org", api_key="...")

    agent = aria.register_agent(name="my-agent", scope=["read:data", "send:email"])
    # Guarda agent["did"] y agent["secret"]

    result = aria.track(
        agent["did"], agent["secret"], "read:data",
        lambda: fetch_user_data(user_id),
    )
"""
import hashlib
import hmac
import json
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import requests


# ─────────────────────────── Excepciones ────────────────────────────

class ScopeViolationException(Exception):
    """La accion no esta dentro del scope declarado del agente. fn() no se ejecuto."""

    code = "SCOPE_VIOLATION"

    def __init__(self, action: str, allowed_scope: List[str]):
        self.action = action
        self.allowed_scope = allowed_scope
        super().__init__(
            f"Action '{action}' is not in the agent's declared scope. "
            f"Allowed: [{', '.join(allowed_scope)}]. Execution blocked by ARIA."
        )


class GateDeniedException(Exception):
    """El owner denego la accion gateada. fn() no se ejecuto."""

    def __init__(self, request_id: str, action: str):
        self.request_id = request_id
        self.action = action
        super().__init__(f"Gate denied: action '{action}' was denied by the owner")


class GateBlockedException(Exception):
    """La accion coincide con una regla auto_block. fn() no se ejecuto."""

    def __init__(self, action: str):
        self.action = action
        super().__init__(f"Gate blocked: action '{action}' is auto-blocked")


class GateTimeoutException(Exception):
    """No se recibio aprobacion dentro del tiempo limite. fn() no se ejecuto."""

    def __init__(self, request_id: str, action: str):
        self.request_id = request_id
        self.action = action
        super().__init__(f"Gate timeout: no approval received for '{action}'")


class EventLimitException(Exception):
    """Se alcanzo el limite mensual de eventos del plan."""

    code = "EVENT_LIMIT_REACHED"

    def __init__(
        self,
        message: str,
        current_events: Optional[int] = None,
        max_events: Optional[int] = None,
    ):
        self.current_events = current_events
        self.max_events = max_events
        super().__init__(message)


# ─────────────────────────── Resultado ──────────────────────────────

class TrackResult:
    """Resultado de track(). `value` contiene lo que devolvio fn()."""

    def __init__(
        self,
        success: bool,
        event_id: str,
        value: Any = None,
        limit_reached: bool = False,
        insights: Optional[Dict[str, Any]] = None,
    ):
        self.success = success
        self.event_id = event_id
        self.value = value
        self.limit_reached = limit_reached
        self.insights = insights

    def __repr__(self) -> str:
        return (
            f"TrackResult(success={self.success}, event_id={self.event_id!r}, "
            f"limit_reached={self.limit_reached})"
        )


# ────────────────────── Caché de scope (modulo) ─────────────────────

_SCOPE_CACHE: Dict[str, Dict[str, Any]] = {}
_SCOPE_CACHE_TTL_SECONDS = 5 * 60


def _action_matches_scope(action: str, scope: List[str]) -> bool:
    for item in scope:
        if item == action:
            return True
        if item.endswith(":*") and action.startswith(item[:-1]):
            return True
    return False


def _iso_now() -> str:
    """ISO 8601 con milisegundos y sufijo Z, igual que Date.toISOString() en JS."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


# ─────────────────────────── Cliente ────────────────────────────────

class ARIAClient:
    """
    Cliente sin estado contra la API de ARIA. Una instancia puede rastrear
    cualquier numero de agentes; las credenciales (did + secret) se pasan en
    cada llamada a track(), igual que en el SDK de TypeScript.
    """

    def __init__(self, base_url: str, api_key: str, timeout: int = 10):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # ── Registro ──────────────────────────────────────────────────

    def register_agent(
        self,
        name: str,
        scope: List[str],
        meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Registra un agente y devuelve {did, secret, name, scope}.
        Guarda el `secret`: es necesario para firmar cada evento y no se
        puede recuperar despues sin el endpoint de recuperacion.
        """
        payload: Dict[str, Any] = {"name": name, "scope": scope}
        if meta is not None:
            payload["meta"] = meta

        res = requests.post(
            f"{self.base_url}/v1/agents",
            headers=self._headers,
            json=payload,
            timeout=self.timeout,
        )
        if not res.ok:
            raise RuntimeError(f"ARIA: Failed to register agent - {res.status_code}")

        data = res.json()
        agent = data.get("agent", {})
        did = agent.get("did")
        secret = data.get("secret")
        if not isinstance(did, str) or not isinstance(secret, str):
            raise ValueError("Servidor ARIA no devolvio credenciales de firma validas")

        return {
            "did": did,
            "secret": secret,
            "name": agent.get("name", name),
            "scope": agent.get("scope", scope),
        }

    # ── Rastreo de acciones ───────────────────────────────────────

    def track(
        self,
        agent_did: str,
        secret: str,
        action: str,
        fn: Callable[[], Any],
        mode: str = "enforce",
        gate: Optional[Dict[str, Any]] = None,
    ) -> TrackResult:
        """
        Ejecuta fn() bajo la supervision de ARIA y registra la accion.

        mode="light"   : sin latencia anadida; scope y evento van en background.
        mode="enforce" : chequeo de scope bloqueante antes de fn() (por defecto).
        mode="gate"    : chequeo de scope + aprobacion humana antes de fn().

        En modo enforce/gate, una violacion de scope o una denegacion del gate
        lanzan una excepcion y fn() NO se ejecuta.
        """
        if mode == "light":
            return self._track_light(agent_did, secret, action, fn)

        # enforce y gate: chequeo de scope bloqueante ANTES de fn()
        agent_scope = self._get_agent_scope(agent_did)
        if agent_scope and not _action_matches_scope(action, agent_scope):
            self._send_blocked_event_background(agent_did, secret, action)
            raise ScopeViolationException(action, agent_scope)

        if mode == "gate" and gate:
            # Paso 1: chequear el gate ANTES de ejecutar.
            self._gate_check(
                action, agent_did, gate,
                context={"action": action, "requestedAt": _iso_now()},
            )
            # Si _gate_check lanza, fn() nunca se ejecuta.

        # Paso 2: gate aprobado (o modo enforce) — ejecutar fn().
        start = time.monotonic()
        outcome = "success"
        fn_error: Optional[str] = None
        value: Any = None
        try:
            value = fn()
        except Exception as err:  # noqa: BLE001 — se replica el comportamiento del SDK TS
            outcome = "error"
            fn_error = str(err)

        duration_ms = int((time.monotonic() - start) * 1000)
        result = self._build_and_send_event(
            agent_did, secret, action, outcome, duration_ms, fn_error
        )
        result.value = value
        return result

    def _track_light(
        self,
        agent_did: str,
        secret: str,
        action: str,
        fn: Callable[[], Any],
    ) -> TrackResult:
        # El chequeo de scope corre en background y nunca anade latencia a fn().
        def _bg_scope_check() -> None:
            try:
                agent_scope = self._get_agent_scope(agent_did)
                if agent_scope and not _action_matches_scope(action, agent_scope):
                    self._send_blocked_event_background(agent_did, secret, action)
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=_bg_scope_check, daemon=True).start()

        start = time.monotonic()
        outcome = "success"
        fn_error: Optional[str] = None
        value: Any = None
        try:
            value = fn()
        except Exception as err:  # noqa: BLE001
            outcome = "error"
            fn_error = str(err)

        duration_ms = int((time.monotonic() - start) * 1000)
        self._send_event_background(
            agent_did, secret, action, outcome, duration_ms, fn_error
        )
        return TrackResult(success=True, event_id=str(uuid.uuid4()), value=value)

    # ── Gate (aprobacion humana) ──────────────────────────────────

    def _gate_check(
        self,
        action: str,
        agent_did: str,
        options: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> None:
        timeout_ms = options.get("timeoutMs", 5 * 60 * 1000)
        poll_interval_ms = options.get("pollIntervalMs", 2000)
        auto_block = options.get("autoBlock") or []
        require_approval = options.get("requireApproval")

        def _matches(patterns: List[str], act: str) -> bool:
            for pattern in patterns:
                if pattern.endswith(":*") and act.startswith(pattern[:-1]):
                    return True
                if pattern == act:
                    return True
            return False

        # auto_block primero: igual deja rastro en el servidor para auditoria.
        if auto_block and _matches(auto_block, action):
            self._post_gate_request(agent_did, action, context)
            raise GateBlockedException(action)

        # Si la accion no requiere aprobacion, continuar sin gate.
        if not require_approval or not _matches(require_approval, action):
            return

        request_res = self._post_gate_request(agent_did, action, context)
        if request_res is None or not request_res.ok:
            status = request_res.status_code if request_res is not None else "no response"
            raise RuntimeError(f"Gate request failed: {status}")

        request_data = request_res.json()
        if request_data.get("status") == "auto_blocked":
            raise GateBlockedException(action)

        request_id = request_data["requestId"]
        deadline = time.monotonic() + timeout_ms / 1000.0

        while time.monotonic() < deadline:
            time.sleep(poll_interval_ms / 1000.0)
            try:
                poll_res = requests.get(
                    f"{self.base_url}/v1/gate/request/{request_id}",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    timeout=self.timeout,
                )
            except requests.RequestException:
                continue

            if not poll_res.ok:
                continue

            status = poll_res.json().get("status")
            if status == "approved":
                return
            if status == "denied":
                raise GateDeniedException(request_id, action)
            if status == "timeout":
                raise GateTimeoutException(request_id, action)
            # 'pending' → seguir esperando.

        raise GateTimeoutException(request_id, action)

    def _post_gate_request(
        self,
        agent_did: str,
        action: str,
        context: Optional[Dict[str, Any]],
    ) -> Optional[requests.Response]:
        try:
            return requests.post(
                f"{self.base_url}/v1/gate/request",
                headers=self._headers,
                json={"agentDid": agent_did, "action": action, "context": context},
                timeout=self.timeout,
            )
        except requests.RequestException:
            return None

    # ── Envio de eventos ──────────────────────────────────────────

    def _sign(self, secret: str, payload: str) -> str:
        return hmac.new(
            secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _send_blocked_event_background(
        self, agent_did: str, secret: str, action: str
    ) -> None:
        event_id = str(uuid.uuid4())
        timestamp = _iso_now()
        signature = self._sign(
            secret, f"{event_id}:{agent_did}:{action}:blocked:{timestamp}"
        )
        body = {
            "eventId": event_id,
            "agentDid": agent_did,
            "action": action,
            "outcome": "blocked",
            "withinScope": False,
            "durationMs": 0,
            "timestamp": timestamp,
            "signature": signature,
            "meta": {"blocked_by": "aria_scope_check"},
        }

        def _send() -> None:
            try:
                requests.post(
                    f"{self.base_url}/v1/events",
                    headers=self._headers,
                    data=json.dumps(body),
                    timeout=self.timeout,
                )
            except requests.RequestException:
                pass

        threading.Thread(target=_send, daemon=True).start()

    def _send_event_background(
        self,
        agent_did: str,
        secret: str,
        action: str,
        outcome: str,
        duration_ms: int,
        error: Optional[str],
    ) -> None:
        def _send() -> None:
            try:
                self._build_and_send_event(
                    agent_did, secret, action, outcome, duration_ms, error
                )
            except EventLimitException:
                print(
                    "[ARIA] Monthly event limit reached. Events are being dropped. "
                    "Upgrade your plan at https://ariatrust.org/pricing"
                )
            except Exception:  # noqa: BLE001 — fire and forget
                pass

        threading.Thread(target=_send, daemon=True).start()

    def _build_and_send_event(
        self,
        agent_did: str,
        secret: str,
        action: str,
        outcome: str,
        duration_ms: int,
        error: Optional[str] = None,
    ) -> TrackResult:
        event_id = str(uuid.uuid4())
        timestamp = _iso_now()
        signature = self._sign(
            secret, f"{event_id}:{agent_did}:{action}:{outcome}:{timestamp}"
        )
        body: Dict[str, Any] = {
            "eventId": event_id,
            "agentDid": agent_did,
            "action": action,
            "outcome": outcome,
            "withinScope": True,
            "durationMs": duration_ms,
            "timestamp": timestamp,
            "signature": signature,
        }
        if error is not None:
            body["error"] = error

        res = requests.post(
            f"{self.base_url}/v1/events",
            headers=self._headers,
            data=json.dumps(body),
            timeout=self.timeout,
        )

        if not res.ok:
            if res.status_code == 429:
                try:
                    err_data = res.json()
                except ValueError:
                    err_data = {}
                if err_data.get("code") == "EVENT_LIMIT_REACHED":
                    raise EventLimitException(
                        err_data.get("error", "Monthly event limit reached"),
                        err_data.get("current_events"),
                        err_data.get("max_events"),
                    )
            return TrackResult(success=False, event_id=event_id)

        data = res.json()
        return TrackResult(
            success=bool(data.get("accepted")),
            event_id=data.get("eventId", event_id),
            insights=data.get("insights"),
        )

    # ── Lectura ───────────────────────────────────────────────────

    def get_agent(self, did: str) -> Dict[str, Any]:
        res = requests.get(
            f"{self.base_url}/v1/agents/{did}",
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=self.timeout,
        )
        if not res.ok:
            raise RuntimeError("ARIA: Agent not found")
        return res.json()

    def list_agents(self, name: Optional[str] = None) -> Dict[str, Any]:
        params = {"name": name} if name else None
        res = requests.get(
            f"{self.base_url}/v1/agents",
            headers={"Authorization": f"Bearer {self.api_key}"},
            params=params,
            timeout=self.timeout,
        )
        return res.json()

    def _get_agent_scope(self, agent_did: str) -> List[str]:
        cached = _SCOPE_CACHE.get(agent_did)
        if cached and (time.monotonic() - cached["cached_at"]) < _SCOPE_CACHE_TTL_SECONDS:
            return cached["scope"]
        try:
            res = requests.get(
                f"{self.base_url}/v1/agents/{agent_did}",
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=self.timeout,
            )
            if not res.ok:
                return []
            scope = (res.json().get("agent") or {}).get("scope") or []
            _SCOPE_CACHE[agent_did] = {"scope": scope, "cached_at": time.monotonic()}
            return scope
        except requests.RequestException:
            return []


def create_client(base_url: str, api_key: str, timeout: int = 10) -> ARIAClient:
    """Equivalente a createClient() del SDK de TypeScript."""
    return ARIAClient(base_url=base_url, api_key=api_key, timeout=timeout)
