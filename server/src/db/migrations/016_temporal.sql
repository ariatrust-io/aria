-- Temporal anchors — periodic snapshots of event hash chain
CREATE TABLE IF NOT EXISTS temporal_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id)
    ON DELETE CASCADE,
  anchor_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  last_event_id TEXT,
  anchor_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_anchor_id UUID REFERENCES temporal_anchors(id),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_temporal_anchors_agent_id
  ON temporal_anchors(agent_id);
CREATE INDEX IF NOT EXISTS idx_temporal_anchors_time
  ON temporal_anchors(anchor_time DESC);

-- Temporal proofs — proof for a specific event
CREATE TABLE IF NOT EXISTS temporal_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id)
    ON DELETE CASCADE,
  event_hash TEXT NOT NULL,
  anchor_id UUID NOT NULL
    REFERENCES temporal_anchors(id),
  proof_chain JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id)
);

CREATE INDEX IF NOT EXISTS idx_temporal_proofs_event_id
  ON temporal_proofs(event_id);
CREATE INDEX IF NOT EXISTS idx_temporal_proofs_agent_id
  ON temporal_proofs(agent_id);
