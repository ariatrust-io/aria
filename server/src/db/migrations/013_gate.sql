CREATE TABLE IF NOT EXISTS gate_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action_pattern TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (
    rule_type IN ('require_approval', 'auto_block')
  ),
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gate_rules_agent_id
  ON gate_rules(agent_id);

CREATE TABLE IF NOT EXISTS gate_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  agent_did TEXT NOT NULL,
  action TEXT NOT NULL,
  context JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','timeout','auto_blocked')),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  timeout_at TIMESTAMPTZ NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_requests_agent_id
  ON gate_requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_gate_requests_status
  ON gate_requests(status);
CREATE INDEX IF NOT EXISTS idx_gate_requests_user_id
  ON gate_requests(user_id);
