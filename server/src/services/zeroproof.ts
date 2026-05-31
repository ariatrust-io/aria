import { createHash } from 'crypto';
import { query } from '../db/pool.js';
import {
  buildMerkleTree,
  generateProof
} from '../utils/merkle.js';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

const PROOF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── Shared derivation helpers ───────────────────────────────────────────────
// Generation AND verification go through these, so the Merkle root that an
// auditor recomputes can never drift from the one we stored. Verification
// re-derives everything from the immutable event log, not from the proof body.

function eventToLeaf(event: {
  event_id: string;
  action: string;
  outcome: string;
  client_ts: string;
  server_within_scope: boolean;
}): string {
  return sha256([
    event.event_id,
    event.action,
    event.outcome,
    event.client_ts,
    String(event.server_within_scope)
  ].join(':'));
}

interface WindowEvent {
  event_id: string;
  action: string;
  outcome: string;
  client_ts: string;
  server_within_scope: boolean;
}

async function fetchWindowEvents(
  agentId: string, windowStart: Date, windowEnd: Date
): Promise<WindowEvent[]> {
  const res = await query<WindowEvent>(`
    SELECT event_id, action, outcome,
           client_ts::text, server_within_scope
    FROM events
    WHERE agent_id = $1
      AND client_ts BETWEEN $2 AND $3
    ORDER BY client_ts ASC
    LIMIT 10000
  `, [agentId, windowStart, windowEnd]);
  return res.rows;
}

function countViolations(events: WindowEvent[], forbiddenPattern: string): number {
  const isWildcard = forbiddenPattern.endsWith(':*');
  const prefix = isWildcard ? forbiddenPattern.slice(0, -1) : null;
  return events.filter(e =>
    isWildcard ? e.action.startsWith(prefix!) : e.action === forbiddenPattern
  ).length;
}

interface ConsistencyStats { total: string; successes: string; success_rate: string }

async function fetchConsistencyStats(
  agentId: string, windowStart: Date, windowEnd: Date
): Promise<ConsistencyStats> {
  const res = await query<ConsistencyStats>(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (
        WHERE outcome = 'success' AND server_within_scope = true
      ) AS successes,
      ROUND(
        COUNT(*) FILTER (
          WHERE outcome = 'success' AND server_within_scope = true
        )::numeric / NULLIF(COUNT(*), 0) * 100, 2
      ) AS success_rate
    FROM events
    WHERE agent_id = $1
      AND client_ts BETWEEN $2 AND $3
  `, [agentId, windowStart, windowEnd]);
  return res.rows[0]!;
}

function consistencyLeaves(
  total: number, successes: string, successRate: number,
  windowStart: Date, windowEnd: Date, minSuccessRate: number
): string[] {
  return [
    sha256(`total:${total}`),
    sha256(`successes:${successes}`),
    sha256(`rate:${successRate}`),
    sha256(`window:${windowStart.toISOString()}:${windowEnd.toISOString()}`),
    sha256(`threshold:${minSuccessRate}`)
  ];
}

async function fetchHourlyPeaks(
  agentId: string, windowStart: Date, windowEnd: Date
): Promise<string[]> {
  const res = await query<{ event_count: string }>(`
    SELECT COUNT(*) AS event_count
    FROM events
    WHERE agent_id = $1
      AND client_ts BETWEEN $2 AND $3
    GROUP BY DATE_TRUNC('hour', client_ts)
    ORDER BY event_count DESC
    LIMIT 10
  `, [agentId, windowStart, windowEnd]);
  return res.rows.map(r => r.event_count);
}

// ── Proof generation ────────────────────────────────────────────────────────

export async function generateInnocenceProof(
  agentId: string,
  forbiddenPattern: string,
  windowDays: number = 30
): Promise<{
  proof_id: string;
  claim: string;
  merkle_root: string;
  verified: boolean;
  proof_data: Record<string, unknown>;
  expires_at: string;
} | null> {
  const windowStart = new Date(Date.now() - windowDays * 86_400_000);
  const windowEnd = new Date();

  const events = await fetchWindowEvents(agentId, windowStart, windowEnd);
  const violations = countViolations(events, forbiddenPattern);
  const isInnocent = violations === 0;

  const tree = buildMerkleTree(events.map(eventToLeaf));

  const claim = isInnocent
    ? `Agent never executed '${forbiddenPattern}' ` +
      `in the last ${windowDays} days`
    : `Agent executed '${forbiddenPattern}' ` +
      `${violations} time(s) — innocence CANNOT be proven`;

  const proofData = {
    proof_type: 'innocence',
    forbidden_pattern: forbiddenPattern,
    window_days: windowDays,
    total_events: events.length,
    violations_found: violations,
    is_innocent: isInnocent,
    merkle_root: tree.root,
    event_count_commitment: sha256(`${events.length}:${tree.root}`),
    verification_instructions: isInnocent
      ? `1. Obtain the event log from ARIA API\n` +
        `2. Build a Merkle tree from the event hashes\n` +
        `3. Verify the root matches: ${tree.root}\n` +
        `4. Confirm no leaf corresponds to '${forbiddenPattern}'`
      : 'Innocence proof cannot be generated — violations exist'
  };

  const expiresAt = new Date(Date.now() + PROOF_TTL_MS);

  const result = await query<{ id: string }>(`
    INSERT INTO zero_proofs
      (agent_id, proof_type, claim, merkle_root,
       proof_data, window_start, window_end,
       verified, expires_at)
    VALUES ($1,'innocence',$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, [
    agentId, claim, tree.root,
    JSON.stringify(proofData),
    windowStart, windowEnd,
    isInnocent, expiresAt
  ]);

  return {
    proof_id: result.rows[0]!.id,
    claim,
    merkle_root: tree.root,
    verified: isInnocent,
    proof_data: proofData,
    expires_at: expiresAt.toISOString()
  };
}

export async function generateConsistencyProof(
  agentId: string,
  minSuccessRate: number = 90,
  windowDays: number = 30
): Promise<{
  proof_id: string;
  claim: string;
  merkle_root: string;
  verified: boolean;
  proof_data: Record<string, unknown>;
  expires_at: string;
} | null> {
  const windowStart = new Date(Date.now() - windowDays * 86_400_000);
  const windowEnd = new Date();

  const s = await fetchConsistencyStats(agentId, windowStart, windowEnd);
  const total = parseInt(s.total);
  const successRate = parseFloat(s.success_rate ?? '0');
  const meetsThreshold = successRate >= minSuccessRate;

  const statsCommitment = sha256(
    `${total}:${s.successes}:${successRate}:${windowStart.toISOString()}`
  );

  const tree = buildMerkleTree(
    consistencyLeaves(total, s.successes, successRate, windowStart, windowEnd, minSuccessRate)
  );

  const claim = meetsThreshold
    ? `Agent maintained ≥${minSuccessRate}% success rate ` +
      `over the last ${windowDays} days ` +
      `(actual: ${successRate}%)`
    : `Agent success rate (${successRate}%) ` +
      `is below threshold (${minSuccessRate}%) — ` +
      `consistency CANNOT be proven`;

  const proofData = {
    proof_type: 'consistency',
    min_success_rate: minSuccessRate,
    actual_success_rate: successRate,
    total_events: total,
    window_days: windowDays,
    meets_threshold: meetsThreshold,
    stats_commitment: statsCommitment,
    merkle_root: tree.root,
    threshold_proof: generateProof(tree, 4),
    verification_instructions:
      `1. Obtain event stats from ARIA API\n` +
      `2. Compute commitment: sha256(total:successes:rate:window)\n` +
      `3. Verify commitment matches: ${statsCommitment}\n` +
      `4. Confirm success rate ≥ ${minSuccessRate}%`
  };

  const expiresAt = new Date(Date.now() + PROOF_TTL_MS);

  const result = await query<{ id: string }>(`
    INSERT INTO zero_proofs
      (agent_id, proof_type, claim, merkle_root,
       proof_data, window_start, window_end,
       verified, expires_at)
    VALUES ($1,'consistency',$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, [
    agentId, claim, tree.root,
    JSON.stringify(proofData),
    windowStart, windowEnd,
    meetsThreshold, expiresAt
  ]);

  return {
    proof_id: result.rows[0]!.id,
    claim,
    merkle_root: tree.root,
    verified: meetsThreshold,
    proof_data: proofData,
    expires_at: expiresAt.toISOString()
  };
}

export async function generateLimitsProof(
  agentId: string,
  maxEventsPerHour: number = 100,
  windowDays: number = 30
): Promise<{
  proof_id: string;
  claim: string;
  merkle_root: string;
  verified: boolean;
  proof_data: Record<string, unknown>;
  expires_at: string;
} | null> {
  const windowStart = new Date(Date.now() - windowDays * 86_400_000);
  const windowEnd = new Date();

  const hourlyCounts = await fetchHourlyPeaks(agentId, windowStart, windowEnd);
  const peakHour = parseInt(hourlyCounts[0] ?? '0');
  const withinLimits = peakHour <= maxEventsPerHour;

  const tree = buildMerkleTree(hourlyCounts.map(c => sha256(`hour:${c}`)));

  const claim = withinLimits
    ? `Agent never exceeded ${maxEventsPerHour} events/hour ` +
      `over the last ${windowDays} days ` +
      `(peak: ${peakHour} events/hour)`
    : `Agent exceeded ${maxEventsPerHour} events/hour ` +
      `(peak: ${peakHour}) — limits proof CANNOT be generated`;

  const proofData = {
    proof_type: 'limits',
    max_events_per_hour: maxEventsPerHour,
    peak_events_per_hour: peakHour,
    within_limits: withinLimits,
    window_days: windowDays,
    hourly_buckets_count: hourlyCounts.length,
    merkle_root: tree.root,
    peak_commitment: sha256(`peak:${peakHour}:${maxEventsPerHour}`),
    verification_instructions:
      `1. Obtain hourly event counts from ARIA API\n` +
      `2. Build Merkle tree from hourly count hashes\n` +
      `3. Verify root matches: ${tree.root}\n` +
      `4. Confirm all counts ≤ ${maxEventsPerHour}`
  };

  const expiresAt = new Date(Date.now() + PROOF_TTL_MS);

  const result = await query<{ id: string }>(`
    INSERT INTO zero_proofs
      (agent_id, proof_type, claim, merkle_root,
       proof_data, window_start, window_end,
       verified, expires_at)
    VALUES ($1,'limits',$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, [
    agentId, claim, tree.root,
    JSON.stringify(proofData),
    windowStart, windowEnd,
    withinLimits, expiresAt
  ]);

  return {
    proof_id: result.rows[0]!.id,
    claim,
    merkle_root: tree.root,
    verified: withinLimits,
    proof_data: proofData,
    expires_at: expiresAt.toISOString()
  };
}

// ── Real verification ───────────────────────────────────────────────────────
// Re-derives the Merkle root from the immutable event log and confirms it still
// equals the stored root. This is a genuine recomputation, not a comparison of
// two copies of the same stored value.

export async function verifyZeroProof(
  proofId: string
): Promise<{
  valid: boolean;
  claim: string;
  proof_type: string;
  merkle_root: string;
  recomputed_root: string | null;
  verified: boolean;
  created_at: string;
  expires_at: string;
  expired: boolean;
}> {
  const result = await query<{
    id: string;
    agent_id: string;
    proof_type: string;
    claim: string;
    merkle_root: string;
    proof_data: Record<string, unknown>;
    verified: boolean;
    window_start: string;
    window_end: string;
    created_at: string;
    expires_at: string;
  }>(`
    SELECT id, agent_id::text AS agent_id, proof_type, claim, merkle_root,
           proof_data, verified,
           window_start::text, window_end::text,
           created_at::text, expires_at::text
    FROM zero_proofs
    WHERE id = $1
  `, [proofId]);

  if (!result.rows[0]) {
    throw new Error('Proof not found');
  }

  const proof = result.rows[0];
  const expired = new Date() > new Date(proof.expires_at);
  const pd = proof.proof_data;
  const windowStart = new Date(proof.window_start);
  const windowEnd = new Date(proof.window_end);

  let recomputedRoot: string | null = null;

  try {
    if (proof.proof_type === 'innocence') {
      const events = await fetchWindowEvents(proof.agent_id, windowStart, windowEnd);
      recomputedRoot = buildMerkleTree(events.map(eventToLeaf)).root;
    } else if (proof.proof_type === 'consistency') {
      const s = await fetchConsistencyStats(proof.agent_id, windowStart, windowEnd);
      const total = parseInt(s.total);
      const successRate = parseFloat(s.success_rate ?? '0');
      const minSuccessRate = Number(pd.min_success_rate ?? 0);
      recomputedRoot = buildMerkleTree(
        consistencyLeaves(total, s.successes, successRate, windowStart, windowEnd, minSuccessRate)
      ).root;
    } else if (proof.proof_type === 'limits') {
      const hourly = await fetchHourlyPeaks(proof.agent_id, windowStart, windowEnd);
      recomputedRoot = buildMerkleTree(hourly.map(c => sha256(`hour:${c}`))).root;
    }
  } catch {
    recomputedRoot = null;
  }

  const rootMatches = recomputedRoot !== null && recomputedRoot === proof.merkle_root;

  return {
    valid: rootMatches && !expired,
    claim: proof.claim,
    proof_type: proof.proof_type,
    merkle_root: proof.merkle_root,
    recomputed_root: recomputedRoot,
    verified: proof.verified,
    created_at: proof.created_at,
    expires_at: proof.expires_at,
    expired
  };
}
