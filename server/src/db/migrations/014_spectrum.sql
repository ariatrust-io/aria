CREATE TABLE IF NOT EXISTS behavior_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id)
    ON DELETE CASCADE,
  pattern_type TEXT NOT NULL,
  -- Types: 'temporal', 'action_failure', 'scope_pattern', 'frequency_spike'
  action TEXT,
  description TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  severity TEXT NOT NULL DEFAULT 'LOW'
    CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  metadata JSONB DEFAULT '{}',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_behavior_patterns_agent_id
  ON behavior_patterns(agent_id);
CREATE INDEX IF NOT EXISTS idx_behavior_patterns_type
  ON behavior_patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_behavior_patterns_severity
  ON behavior_patterns(severity);

CREATE UNIQUE INDEX IF NOT EXISTS uq_behavior_patterns_with_action
  ON behavior_patterns (agent_id, pattern_type, action)
  WHERE action IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_behavior_patterns_without_action
  ON behavior_patterns (agent_id, pattern_type)
  WHERE action IS NULL;
