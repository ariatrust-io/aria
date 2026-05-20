-- Allow 'blocked' as a valid event outcome
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_outcome_check;

ALTER TABLE events
  ADD CONSTRAINT events_outcome_check
  CHECK (outcome IN ('success', 'error', 'anomaly', 'blocked'));

-- Track blocked events in reputation snapshots
ALTER TABLE reputation_snapshots
  ADD COLUMN IF NOT EXISTS blocked_count INTEGER NOT NULL DEFAULT 0;
