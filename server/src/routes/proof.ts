import { Router } from 'express';
import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';
import { query } from '../db/pool.js';
import { getRedisClient } from '../utils/redis.js';
import { createRedisStore } from '../utils/network.js';
import { verifyProof, type MerkleProof } from '../utils/merkle.js';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * PUBLIC "LIVE PROOF" API
 *
 * Read-only, anonymized window into the ARIA demo agent. Everything here is
 * hardcoded to a single agent and every SQL SELECT lists only safe columns so
 * sensitive fields (signature, secret, full DID, user_id, raw payload) can
 * never leak — even by accident.
 */

// ── DEMO AGENT (hardcoded — this is the ONLY agent these endpoints expose) ──
const DEMO_DID = 'did:agentrust:20c1a019-b293-42cc-a235-6675384e548f';
// Visual-only: partial DID shown to the public (first 4 chars after prefix).
const DID_PARTIAL = 'did:agentrust:20c1...';

export const proofRouter = Router();

// ── Rate limit: 30 requests / minute / IP ──
const _proofRedis = getRedisClient();
const proofLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore(_proofRedis, 'rl:proof:'),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too many requests. Max 30 per minute.',
      code: 'RATE_LIMITED'
    });
  }
});
proofRouter.use(proofLimiter);

// ── Tiny in-memory TTL cache ──
type CacheEntry = { value: unknown; expires: number };
const cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  if (hit) cache.delete(key);
  return null;
}

function setCached(key: string, value: unknown, ttlMs: number): void {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

// Agent UUID never changes, so resolve it once and keep it.
let demoAgentIdCache: string | null = null;

async function getDemoAgentId(): Promise<string | null> {
  if (demoAgentIdCache) return demoAgentIdCache;
  const r = await query<{ id: string }>(
    'SELECT id FROM agents WHERE did = $1',
    [DEMO_DID]
  );
  demoAgentIdCache = r.rows[0]?.id ?? null;
  return demoAgentIdCache;
}

// The hash formula MUST match services/temporal-anchor.ts exactly, or
// recomputed hashes will never line up with stored proofs.
function hashEvent(e: {
  event_id: string;
  action: string;
  outcome: string;
  client_ts: string;
  signature: string;
  agent_id: string;
}): string {
  const payload = [
    e.event_id,
    e.action,
    e.outcome,
    e.client_ts,
    e.signature,
    e.agent_id
  ].join(':');
  return createHash('sha256').update(payload).digest('hex');
}

// ───────────────────────────────────────────────────────────────────────────
// GET /v1/proof/public/stats  — aggregate counters (cached 60s)
// ───────────────────────────────────────────────────────────────────────────
proofRouter.get('/public/stats', async (_req, res) => {
  try {
    const cached = getCached('stats');
    if (cached) return res.json(cached);

    const agentId = await getDemoAgentId();
    if (!agentId) {
      return res.status(503).json({ error: 'Demo agent unavailable', code: 'NO_DEMO_AGENT' });
    }

    const statsResult = await query<{
      total_events: string;
      successful_count: string;
      error_count: string;
      gated_count: string;
      first_ts: string | null;
    }>(
      `SELECT
         COUNT(*)::int                                                          AS total_events,
         COUNT(*) FILTER (WHERE outcome = 'success')::int                       AS successful_count,
         COUNT(*) FILTER (WHERE outcome = 'error')::int                         AS error_count,
         COUNT(*) FILTER (WHERE server_within_scope = false
                             OR outcome = 'blocked')::int                       AS gated_count,
         MIN(client_ts)::text                                                   AS first_ts
       FROM events
       WHERE agent_id = $1`,
      [agentId]
    );

    const s = statsResult.rows[0]!;

    const anomalyResult = await query<{ c: string }>(
      'SELECT COUNT(*)::int AS c FROM anomalies WHERE agent_id = $1',
      [agentId]
    );

    // Temporal-anchor tables may not exist in every environment — never let a
    // missing table break the whole stats endpoint.
    let latestRoot: string | null = null;
    let sampleEventId: string | null = null;
    try {
      const anchorResult = await query<{ anchor_hash: string }>(
        `SELECT anchor_hash FROM temporal_anchors
         WHERE agent_id = $1 ORDER BY anchor_time DESC LIMIT 1`,
        [agentId]
      );
      latestRoot = anchorResult.rows[0]?.anchor_hash ?? null;

      // A real, currently-verifiable event the public page can pre-fill into
      // the Merkle verifier. Prefer an anchored success event, then any
      // anchored event — so a paste-and-verify always shows ✅ when possible.
      const sampleResult = await query<{ event_id: string }>(
        `SELECT e.event_id
         FROM events e
         JOIN temporal_proofs tp ON tp.event_id = e.event_id
         WHERE e.agent_id = $1
         ORDER BY (e.outcome = 'success') DESC, e.recorded_at DESC
         LIMIT 1`,
        [agentId]
      );
      sampleEventId = sampleResult.rows[0]?.event_id ?? null;
    } catch {
      // temporal tables absent — leave root/sample null
    }

    // Fallback: if nothing is anchored yet, still hand the page a real event
    // ID so visitors have something to paste (verify will report it honestly).
    if (!sampleEventId) {
      const anyEvent = await query<{ event_id: string }>(
        `SELECT event_id FROM events
         WHERE agent_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [agentId]
      );
      sampleEventId = anyEvent.rows[0]?.event_id ?? null;
    }

    const firstTs = s.first_ts ? new Date(s.first_ts) : null;
    const agentAgeDays = firstTs
      ? Math.max(0, Math.floor((Date.now() - firstTs.getTime()) / 86_400_000))
      : 0;

    const payload = {
      agent: 'demo-agent-01',
      did_partial: DID_PARTIAL,
      total_events: Number(s.total_events),
      successful_count: Number(s.successful_count),
      error_count: Number(s.error_count),
      gated_count: Number(s.gated_count),
      anomaly_count: Number(anomalyResult.rows[0]?.c ?? 0),
      agent_age_days: agentAgeDays,
      latest_merkle_root: latestRoot,
      sample_event_id: sampleEventId,
      generated_at: new Date().toISOString()
    };

    setCached('stats', payload, 60_000);
    return res.json(payload);
  } catch (err) {
    console.error('[proof] GET /public/stats error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({ error: 'Service unavailable', code: 'INTERNAL_ERROR' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /v1/proof/public/events?limit=50  — anonymized recent events
// ───────────────────────────────────────────────────────────────────────────
proofRouter.get('/public/events', async (req, res) => {
  try {
    const requested = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Math.min(Number.isNaN(requested) ? 50 : Math.max(1, requested), 100);

    const cacheKey = `events:${limit}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const agentId = await getDemoAgentId();
    if (!agentId) {
      return res.status(503).json({ error: 'Demo agent unavailable', code: 'NO_DEMO_AGENT' });
    }

    // Only safe, anonymized columns are ever selected.
    const result = await query<{
      action: string;
      outcome: string;
      scope_valid: boolean;
      duration_ms: number;
      timestamp: string;
    }>(
      `SELECT action,
              outcome,
              server_within_scope AS scope_valid,
              duration_ms,
              client_ts AS timestamp
       FROM events
       WHERE agent_id = $1
       ORDER BY recorded_at DESC
       LIMIT $2`,
      [agentId, limit]
    );

    const payload = {
      did_partial: DID_PARTIAL,
      count: result.rows.length,
      events: result.rows.map((r) => ({
        action: r.action,
        outcome: r.outcome,
        scope_valid: r.scope_valid,
        duration_ms: r.duration_ms,
        timestamp: r.timestamp,
        did_partial: DID_PARTIAL
      }))
    };

    setCached(cacheKey, payload, 10_000);
    return res.json(payload);
  } catch (err) {
    console.error('[proof] GET /public/events error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({ error: 'Service unavailable', code: 'INTERNAL_ERROR' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /v1/proof/public/download/:type  — anonymized CSV (max 50 rows)
//   good = success | bad = error | gated = scope_valid false
// ───────────────────────────────────────────────────────────────────────────
proofRouter.get('/public/download/:type', async (req, res) => {
  try {
    const type = String(req.params.type);
    const filters: Record<string, string> = {
      good: `outcome = 'success'`,
      bad: `outcome = 'error'`,
      gated: `server_within_scope = false`
    };
    const filter = filters[type];
    if (!filter) {
      return res.status(400).json({
        error: 'type must be one of: good, bad, gated',
        code: 'INVALID_TYPE'
      });
    }

    const agentId = await getDemoAgentId();
    if (!agentId) {
      return res.status(503).json({ error: 'Demo agent unavailable', code: 'NO_DEMO_AGENT' });
    }

    const result = await query<{
      action: string;
      outcome: string;
      scope_valid: boolean;
      duration_ms: number;
      timestamp: string | Date;
    }>(
      `SELECT action,
              outcome,
              server_within_scope AS scope_valid,
              duration_ms,
              client_ts AS timestamp
       FROM events
       WHERE agent_id = $1 AND ${filter}
       ORDER BY recorded_at DESC
       LIMIT 50`,
      [agentId]
    );

    const headers = ['action', 'outcome', 'scope_valid', 'duration_ms', 'timestamp', 'did_partial'];
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const str = String(v);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const rows = [
      headers.join(','),
      ...result.rows.map((r) =>
        [r.action, r.outcome, r.scope_valid, r.duration_ms,
         r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
         DID_PARTIAL].map(escape).join(',')
      )
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="aria-demo-agent-01-${type}.csv"`
    );
    return res.send(rows.join('\n'));
  } catch (err) {
    console.error('[proof] GET /public/download error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({ error: 'Service unavailable', code: 'INTERNAL_ERROR' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /v1/proof/public/verify  — REAL Merkle/anchor verification
//   Body: { eventId } → { verified, root, timestamp, action }
// ───────────────────────────────────────────────────────────────────────────
proofRouter.post('/public/verify', async (req, res) => {
  try {
    const { eventId } = (req.body ?? {}) as { eventId?: unknown };
    if (!eventId || typeof eventId !== 'string' || eventId.length > 200) {
      return res.status(400).json({
        verified: false,
        reason: 'eventId is required'
      });
    }

    const agentId = await getDemoAgentId();
    if (!agentId) {
      return res.status(503).json({ verified: false, reason: 'demo agent unavailable' });
    }

    // Recompute the event hash from the raw row and compare to the sealed
    // proof. signature is read for hashing only and is NEVER returned.
    let row: {
      event_id: string;
      action: string;
      outcome: string;
      client_ts: string;
      signature: string;
      agent_id: string;
      event_hash: string | null;
      anchor_hash: string | null;
      proof_chain: unknown;
    } | undefined;

    try {
      const result = await query<typeof row & object>(
        `SELECT e.event_id,
                e.action,
                e.outcome,
                e.client_ts::text  AS client_ts,
                e.signature,
                e.agent_id::text   AS agent_id,
                tp.event_hash,
                tp.proof_chain,
                ta.anchor_hash
         FROM events e
         LEFT JOIN temporal_proofs  tp ON tp.event_id = e.event_id
         LEFT JOIN temporal_anchors ta ON ta.id = tp.anchor_id
         WHERE e.event_id = $1 AND e.agent_id = $2`,
        [eventId, agentId]
      );
      row = result.rows[0];
    } catch {
      // temporal tables absent — fall back to existence-only lookup below
      const exists = await query<{
        action: string; outcome: string; client_ts: string;
      }>(
        `SELECT action, outcome, client_ts::text AS client_ts
         FROM events WHERE event_id = $1 AND agent_id = $2`,
        [eventId, agentId]
      );
      const e = exists.rows[0];
      if (!e) return res.json({ verified: false, reason: 'not found' });
      return res.json({
        verified: false,
        reason: 'event not yet anchored',
        root: null,
        timestamp: e.client_ts,
        action: e.action
      });
    }

    if (!row) {
      return res.json({ verified: false, reason: 'not found' });
    }

    if (!row.event_hash || !row.anchor_hash) {
      return res.json({
        verified: false,
        reason: 'event not yet anchored',
        root: null,
        timestamp: row.client_ts,
        action: row.action
      });
    }

    const recomputed = hashEvent({
      event_id: row.event_id,
      action: row.action,
      outcome: row.outcome,
      client_ts: row.client_ts,
      signature: row.signature,
      agent_id: row.agent_id
    });

    // v2 proofs carry a Merkle sibling path: prove the event is actually a leaf
    // of the anchor root (real inclusion), not just that the row still hashes
    // to its own stored fingerprint.
    const pc = row.proof_chain as {
      v?: number;
      merkle_root?: string;
      leaf_index?: number;
      siblings?: MerkleProof['siblings'];
      event_hash?: string;
    } | null;

    if (pc && pc.v === 2 && Array.isArray(pc.siblings) && pc.merkle_root) {
      const integrityOk = recomputed === pc.event_hash;
      const inclusionOk = verifyProof({
        leaf: sha256(recomputed),
        leafIndex: pc.leaf_index ?? 0,
        siblings: pc.siblings,
        root: pc.merkle_root
      });
      const verified = integrityOk && inclusionOk;
      return res.json({
        verified,
        root: pc.merkle_root,
        timestamp: row.client_ts,
        action: row.action,
        ...(verified ? {} : { reason: 'Merkle inclusion failed — event data may have been altered' })
      });
    }

    // Legacy (v1) proofs: row-integrity comparison against the stored fingerprint.
    const verified = recomputed === row.event_hash;

    return res.json({
      verified,
      root: row.anchor_hash,
      timestamp: row.client_ts,
      action: row.action,
      ...(verified ? {} : { reason: 'hash mismatch — event data may have been altered' })
    });
  } catch (err) {
    console.error('[proof] POST /public/verify error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({ verified: false, reason: 'verification service unavailable' });
  }
});
