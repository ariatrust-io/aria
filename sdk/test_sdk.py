import os

from aria_sdk import ARIAClient, GateDeniedException, ScopeViolationException

# Inicializa el cliente de ARIA (sin estado: una instancia rastrea N agentes).
client = ARIAClient(
    base_url=os.environ.get("ARIA_BASE_URL", "http://127.0.0.1:3001"),
    api_key=os.environ.get("ARIA_API_KEY", "your-api-key-here"),
)

# 1) Registro de agente.
agent = client.register_agent(name="Test Agent", scope=["send:email"])
print("Agent registered successfully!")
print(f"DID: {agent['did']}")

# 2) Track en modo enforce (por defecto): chequea scope antes de ejecutar fn().
result = client.track(
    agent["did"], agent["secret"], "send:email",
    lambda: print("Enviando email..."),
)
print(f"Tracked: {result}")

# 3) Una accion fuera de scope se bloquea antes de ejecutarse.
try:
    client.track(
        agent["did"], agent["secret"], "delete:database",
        lambda: print("Esto NO deberia ejecutarse"),
    )
except ScopeViolationException as e:
    print(f"Bloqueado por scope (esperado): {e.action}")

# 4) Track en modo gate: requiere aprobacion humana antes de ejecutar.
try:
    client.track(
        agent["did"], agent["secret"], "send:email",
        lambda: print("Accion gateada aprobada"),
        mode="gate",
        gate={"requireApproval": ["send:*"], "timeoutMs": 60_000},
    )
except GateDeniedException as e:
    print(f"El owner denego: {e.action}")
