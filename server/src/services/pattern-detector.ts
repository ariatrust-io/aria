import { query } from '../db/pool.js';

const MIN_OCCURRENCES = 3;

interface PatternResult {
  pattern_type: string;
  action: string | null;
  description: string;
  occurrences: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  metadata: Record<string, unknown>;
  first_seen: Date;
  last_seen: Date;
}

async function detectActionFailurePatterns(agentId: string): Promise<PatternResult[]> {
  const result = await query<{
    action: string;
    failure_count: string;
    total_count: string;
    failure_rate: string;
    first_seen: string;
    last_seen: string;
  }>(`
    SELECT
      action,
      COUNT(*) FILTER (WHERE outcome != 'success') AS failure_count,
      COUNT(*) AS total_count,
      ROUND(
        COUNT(*) FILTER (WHERE outcome != 'success')::numeric /
        NULLIF(COUNT(*), 0) * 100, 2
      ) AS failure_rate,
      MIN(client_ts) AS first_seen,
      MAX(client_ts) AS last_seen
    FROM events
    WHERE agent_id = $1
      AND recorded_at > NOW() - INTERVAL '7 days'
    GROUP BY action
    HAVING COUNT(*) FILTER (WHERE outcome != 'success') >= $2
    ORDER BY failure_count DESC
    LIMIT 10
  `, [agentId, MIN_OCCURRENCES]);

  return result.rows.map(row => {
    const failureRate = parseFloat(row.failure_rate);
    const severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
      failureRate >= 80 ? 'CRITICAL' :
      failureRate >= 50 ? 'HIGH' :
      failureRate >= 25 ? 'MEDIUM' : 'LOW';

    return {
      pattern_type: 'action_failure',
      action: row.action,
      description: `Action '${row.action}' fails ${row.failure_rate}% of the time. ` +
        `${row.failure_count} failures out of ${row.total_count} attempts in the last 7 days.`,
      occurrences: parseInt(row.failure_count),
      severity,
      metadata: {
        failure_count: parseInt(row.failure_count),
        total_count: parseInt(row.total_count),
        failure_rate: failureRate
      },
      first_seen: new Date(row.first_seen),
      last_seen: new Date(row.last_seen)
    };
  });
}

async function detectTemporalPatterns(agentId: string): Promise<PatternResult[]> {
  const result = await query<{
    hour: string;
    failure_count: string;
    total_count: string;
    actions: string[];
    first_seen: string;
    last_seen: string;
  }>(`
    SELECT
      EXTRACT(HOUR FROM client_ts AT TIME ZONE 'UTC') AS hour,
      COUNT(*) FILTER (
        WHERE outcome != 'success'
        OR server_within_scope = false
      ) AS failure_count,
      COUNT(*) AS total_count,
      ARRAY_AGG(DISTINCT action) AS actions,
      MIN(client_ts) AS first_seen,
      MAX(client_ts) AS last_seen
    FROM events
    WHERE agent_id = $1
      AND recorded_at > NOW() - INTERVAL '7 days'
      AND (outcome != 'success' OR server_within_scope = false)
    GROUP BY EXTRACT(HOUR FROM client_ts AT TIME ZONE 'UTC')
    HAVING COUNT(*) >= $2
    ORDER BY failure_count DESC
    LIMIT 3
  `, [agentId, MIN_OCCURRENCES]);

  return result.rows.map(row => {
    const hour = parseInt(row.hour);
    const hourStr = `${String(hour).padStart(2, '0')}:00 UTC`;
    const severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
      parseInt(row.failure_count) >= 20 ? 'HIGH' :
      parseInt(row.failure_count) >= 10 ? 'MEDIUM' : 'LOW';

    return {
      pattern_type: 'temporal',
      action: null,
      description: `${row.failure_count} failures detected consistently around ${hourStr}. ` +
        `Affected actions: ${(row.actions || []).slice(0, 3).join(', ')}. ` +
        `This may indicate a scheduled job or recurring trigger.`,
      occurrences: parseInt(row.failure_count),
      severity,
      metadata: {
        peak_hour_utc: hour,
        failure_count: parseInt(row.failure_count),
        affected_actions: row.actions || []
      },
      first_seen: new Date(row.first_seen),
      last_seen: new Date(row.last_seen)
    };
  });
}

async function detectScopePatterns(agentId: string): Promise<PatternResult[]> {
  const result = await query<{
    action: string;
    violation_count: string;
    first_seen: string;
    last_seen: string;
  }>(`
    SELECT
      action,
      COUNT(*) AS violation_count,
      MIN(client_ts) AS first_seen,
      MAX(client_ts) AS last_seen
    FROM events
    WHERE agent_id = $1
      AND server_within_scope = false
      AND recorded_at > NOW() - INTERVAL '7 days'
    GROUP BY action
    HAVING COUNT(*) >= $2
    ORDER BY violation_count DESC
    LIMIT 5
  `, [agentId, MIN_OCCURRENCES]);

  return result.rows.map(row => {
    const count = parseInt(row.violation_count);
    const severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
      count >= 20 ? 'CRITICAL' :
      count >= 10 ? 'HIGH' :
      count >= 5  ? 'MEDIUM' : 'LOW';

    return {
      pattern_type: 'scope_pattern',
      action: row.action,
      description: `Action '${row.action}' is outside declared scope but ` +
        `was attempted ${row.violation_count} times in the last 7 days. ` +
        `This action is not in the agent's allowed scope and should be ` +
        `removed from the agent's code or added to its scope declaration.`,
      occurrences: count,
      severity,
      metadata: {
        violation_count: count,
        action: row.action
      },
      first_seen: new Date(row.first_seen),
      last_seen: new Date(row.last_seen)
    };
  });
}

async function detectFrequencySpikes(agentId: string): Promise<PatternResult[]> {
  const result = await query<{
    window_start: string;
    event_count: string;
  }>(`
    SELECT
      DATE_TRUNC('hour', recorded_at) AS window_start,
      COUNT(*) AS event_count
    FROM events
    WHERE agent_id = $1
      AND recorded_at > NOW() - INTERVAL '7 days'
    GROUP BY DATE_TRUNC('hour', recorded_at)
    HAVING COUNT(*) > 500
    ORDER BY event_count DESC
    LIMIT 3
  `, [agentId]);

  if (result.rows.length === 0) return [];

  return result.rows.map(row => ({
    pattern_type: 'frequency_spike',
    action: null,
    description: `Unusual activity spike detected: ${row.event_count} events ` +
      `in a single hour window starting at ${new Date(row.window_start).toISOString()}. ` +
      `Normal agents send 10-100 events per hour. ` +
      `This may indicate a runaway loop or misconfigured retry logic.`,
    occurrences: parseInt(row.event_count),
    severity: parseInt(row.event_count) > 2000 ? 'CRITICAL' : 'HIGH' as const,
    metadata: {
      window_start: row.window_start,
      event_count: parseInt(row.event_count)
    },
    first_seen: new Date(row.window_start),
    last_seen: new Date(row.window_start)
  }));
}

export async function analyzeAgentBehavior(agentId: string): Promise<void> {
  try {
    const [actionFailures, temporalPatterns, scopePatterns, frequencySpikes] =
      await Promise.all([
        detectActionFailurePatterns(agentId),
        detectTemporalPatterns(agentId),
        detectScopePatterns(agentId),
        detectFrequencySpikes(agentId)
      ]);

    const allPatterns = [
      ...actionFailures,
      ...temporalPatterns,
      ...scopePatterns,
      ...frequencySpikes
    ];

    if (allPatterns.length === 0) return;

    for (const pattern of allPatterns) {
      if (pattern.action !== null) {
        await query(`
          INSERT INTO behavior_patterns
            (agent_id, pattern_type, action, description,
             occurrences, severity, metadata,
             first_seen, last_seen, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
          ON CONFLICT (agent_id, pattern_type, action)
          WHERE action IS NOT NULL
          DO UPDATE SET
            description = EXCLUDED.description,
            occurrences = EXCLUDED.occurrences,
            severity    = EXCLUDED.severity,
            metadata    = EXCLUDED.metadata,
            last_seen   = EXCLUDED.last_seen,
            updated_at  = NOW()
        `, [
          agentId, pattern.pattern_type, pattern.action,
          pattern.description, pattern.occurrences,
          pattern.severity, JSON.stringify(pattern.metadata),
          pattern.first_seen, pattern.last_seen
        ]);
      } else {
        await query(`
          INSERT INTO behavior_patterns
            (agent_id, pattern_type, action, description,
             occurrences, severity, metadata,
             first_seen, last_seen, updated_at)
          VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,NOW())
          ON CONFLICT (agent_id, pattern_type)
          WHERE action IS NULL
          DO UPDATE SET
            description = EXCLUDED.description,
            occurrences = EXCLUDED.occurrences,
            severity    = EXCLUDED.severity,
            metadata    = EXCLUDED.metadata,
            last_seen   = EXCLUDED.last_seen,
            updated_at  = NOW()
        `, [
          agentId, pattern.pattern_type,
          pattern.description, pattern.occurrences,
          pattern.severity, JSON.stringify(pattern.metadata),
          pattern.first_seen, pattern.last_seen
        ]);
      }
    }

    console.log(
      `[spectrum] Analyzed agent ${agentId}: ${allPatterns.length} patterns detected`
    );
  } catch (err) {
    console.error('[spectrum] Analysis failed:',
      err instanceof Error ? err.message : 'Unknown');
  }
}
