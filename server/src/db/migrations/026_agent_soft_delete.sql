-- Soft-delete for agents.
-- Hard-deleting an agent was impossible whenever it had events: the events
-- table is append-only (no_delete_events rule) and events.agent_id references
-- agents(id) without ON DELETE CASCADE, so DELETE FROM agents threw a foreign
-- key violation and the whole request 500'd. Soft-delete keeps the immutable
-- audit trail intact while freeing the plan slot and hiding the agent.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Most lookups filter on "live" agents (deleted_at IS NULL), so a partial index
-- keeps those fast without indexing tombstoned rows.
CREATE INDEX IF NOT EXISTS idx_agents_live
  ON agents (user_id)
  WHERE deleted_at IS NULL;
