CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  target_type TEXT,
  -- 'user', 'agent', 'api_key', 'ip', 'webhook'
  target_id TEXT,
  details JSONB DEFAULT '{}',
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created
  ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action
  ON admin_logs(action);
