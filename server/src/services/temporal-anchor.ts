import { createHash } from 'crypto';
import { query } from '../db/pool.js';
import {
  buildMerkleTree,
  generateProof,
  verifyProof,
  type MerkleProof
} from '../utils/merkle.js';

interface EventData {
  event_id: string;
  action: string;
  outcome: string;
  client_ts: string;
  signature: string;
  agent_id: string;
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

// The per-event fingerprint. Every verifier (public /proof included) recomputes
// this from the raw row, so the formula must never drift.
function hashEvent(event: EventData): string {
  const payload = [
    event.event_id,
    event.action,
    event.outcome,
    event.client_ts,
    event.signature,
    event.agent_id
  ].join(':');
  return sha256(payload);
}

// Shape of the v2 (Merkle) proof stored in temporal_proofs.proof_chain.
interface MerkleProofChain {
  v: 2;
  merkle_root: string;
  leaf_index: number;
  siblings: MerkleProof['siblings'];
  event_hash: string;
}

function isMerkleProofChain(pc: unknown): pc is MerkleProofChain {
  return !!pc && typeof pc === 'object'
    && (pc as { v?: unknown }).v === 2
    && Array.isArray((pc as { siblings?: unknown }).siblings);
}

export async function createTemporalAnchor(
  agentId: string
): Promise<string | null> {
  try {
    const lastAnchor = await query<{
      id: string;
      anchor_hash: string;
      event_count: number;
      last_event_id: string | null;
    }>(`
      SELECT id, anchor_hash, event_count, last_event_id
      FROM temporal_anchors
      WHERE agent_id = $1
      ORDER BY anchor_time DESC
      LIMIT 1
    `, [agentId]);

    const previousAnchor = lastAnchor.rows[0] ?? null;

    let eventsQuery = `
      SELECT
        e.event_id, e.action, e.outcome,
        e.client_ts::text, e.signature,
        e.agent_id::text
      FROM events e
      WHERE e.agent_id = $1
      ORDER BY e.recorded_at ASC
      LIMIT 500
    `;

    const params: unknown[] = [agentId];

    if (previousAnchor?.last_event_id) {
      eventsQuery = `
        SELECT
          e.event_id, e.action, e.outcome,
          e.client_ts::text, e.signature,
          e.agent_id::text
        FROM events e
        WHERE e.agent_id = $1
          AND e.recorded_at > (
            SELECT recorded_at FROM events
            WHERE event_id = $2
          )
        ORDER BY e.recorded_at ASC
        LIMIT 500
      `;
      params.push(previousAnchor.last_event_id);
    }

    const events = await query<EventData>(eventsQuery, params);

    if (events.rows.length === 0) return null;

    // Build a real Merkle tree over this batch of event fingerprints. The
    // anchor_hash IS the Merkle root, so any event can later prove inclusion
    // with a sibling path — not just match its own stored hash.
    const eventHashes = events.rows.map(hashEvent);
    const tree = buildMerkleTree(eventHashes);
    const merkleRoot = tree.root;

    const lastEvent = events.rows[events.rows.length - 1]!;
    const totalEvents = (previousAnchor?.event_count ?? 0)
      + events.rows.length;

    const anchorResult = await query<{ id: string }>(`
      INSERT INTO temporal_anchors
        (agent_id, anchor_hash, event_count,
         last_event_id, previous_anchor_id, metadata)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id
    `, [
      agentId,
      merkleRoot,
      totalEvents,
      lastEvent.event_id,
      previousAnchor?.id ?? null,
      JSON.stringify({
        scheme: 'merkle-v2',
        events_in_window: events.rows.length,
        first_event: events.rows[0]?.event_id,
        last_event: lastEvent.event_id
      })
    ]);

    const anchorId = anchorResult.rows[0]!.id;

    const valuesClauses: string[] = [];
    const bulkParams: unknown[] = [];
    let paramIdx = 1;

    events.rows.forEach((_event, i) => {
      const proof = generateProof(tree, i);
      const proofChain: MerkleProofChain = {
        v: 2,
        merkle_root: merkleRoot,
        leaf_index: i,
        siblings: proof?.siblings ?? [],
        event_hash: eventHashes[i]!
      };
      valuesClauses.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
      );
      bulkParams.push(
        events.rows[i]!.event_id,
        agentId,
        eventHashes[i]!,
        anchorId,
        JSON.stringify(proofChain)
      );
    });

    await query(`
      INSERT INTO temporal_proofs
        (event_id, agent_id, event_hash, anchor_id, proof_chain)
      VALUES ${valuesClauses.join(', ')}
      ON CONFLICT (event_id) DO NOTHING
    `, bulkParams);

    console.log(
      `[temporal] Merkle anchor created for agent ${agentId}: ` +
      `${events.rows.length} events, root: ${merkleRoot.slice(0, 16)}...`
    );

    return merkleRoot;
  } catch (err) {
    console.error('[temporal] createTemporalAnchor failed:',
      err instanceof Error ? err.message : 'Unknown');
    return null;
  }
}

export async function verifyEventProof(
  eventId: string
): Promise<{
  verified: boolean;
  event_hash: string | null;
  anchor_hash: string | null;
  anchor_time: string | null;
  message: string;
}> {
  try {
    const result = await query<{
      event_id: string;
      event_hash: string;
      proof_chain: unknown;
      anchor_hash: string;
      anchor_time: string;
      event_count: number;
    }>(`
      SELECT
        tp.event_id,
        tp.event_hash,
        tp.proof_chain,
        ta.anchor_hash,
        ta.anchor_time::text,
        ta.event_count
      FROM temporal_proofs tp
      JOIN temporal_anchors ta ON ta.id = tp.anchor_id
      WHERE tp.event_id = $1
    `, [eventId]);

    if (!result.rows[0]) {
      return {
        verified: false,
        event_hash: null,
        anchor_hash: null,
        anchor_time: null,
        message: 'No temporal proof found for this event. ' +
          'The event may predate Temporal Anchor deployment.'
      };
    }

    const proof = result.rows[0];

    const eventData = await query<EventData>(`
      SELECT
        e.event_id, e.action, e.outcome,
        e.client_ts::text, e.signature,
        e.agent_id::text
      FROM events e
      WHERE e.event_id = $1
    `, [eventId]);

    if (!eventData.rows[0]) {
      return {
        verified: false,
        event_hash: proof.event_hash,
        anchor_hash: proof.anchor_hash,
        anchor_time: proof.anchor_time,
        message: 'Event data not found — cannot recompute hash'
      };
    }

    const recomputedHash = hashEvent(eventData.rows[0]);

    // v2 proofs carry a Merkle sibling path: prove the event is actually a leaf
    // of the anchor root, not just that the row matches its own stored hash.
    if (isMerkleProofChain(proof.proof_chain)) {
      const pc = proof.proof_chain;
      const integrityOk = recomputedHash === pc.event_hash;
      const inclusionOk = verifyProof({
        leaf: sha256(recomputedHash),
        leafIndex: pc.leaf_index,
        siblings: pc.siblings,
        root: pc.merkle_root
      });
      const verified = integrityOk && inclusionOk
        && pc.merkle_root === proof.anchor_hash;

      return {
        verified,
        event_hash: recomputedHash,
        anchor_hash: pc.merkle_root,
        anchor_time: proof.anchor_time,
        message: verified
          ? `Event verified: it is a Merkle leaf of anchor root ` +
            `${pc.merkle_root.slice(0, 16)}... ` +
            `(anchored ${proof.anchor_time}).`
          : 'Merkle inclusion failed — event data may have been altered'
      };
    }

    // Legacy (v1) chain proofs: fall back to row-integrity comparison.
    const verified = recomputedHash === proof.event_hash;
    return {
      verified,
      event_hash: proof.event_hash,
      anchor_hash: proof.anchor_hash,
      anchor_time: proof.anchor_time,
      message: verified
        ? `Event integrity verified against legacy anchor ` +
          `containing ${proof.event_count} events ` +
          `(anchored ${proof.anchor_time}).`
        : 'Event hash mismatch — event data may have been tampered'
    };
  } catch (err) {
    console.error('[temporal] verifyEventProof failed:',
      err instanceof Error ? err.message : 'Unknown');
    return {
      verified: false,
      event_hash: null,
      anchor_hash: null,
      anchor_time: null,
      message: 'Verification service unavailable'
    };
  }
}

export async function getAnchorSummary(agentId: string): Promise<{
  total_anchors: number;
  total_events_anchored: number;
  latest_anchor_hash: string | null;
  latest_anchor_time: string | null;
  chain_intact: boolean;
}> {
  const result = await query<{
    total_anchors: string;
    total_events_anchored: string;
    latest_id: string | null;
    latest_hash: string | null;
    latest_time: string | null;
  }>(`
    SELECT
      COUNT(*) AS total_anchors,
      MAX(event_count) AS total_events_anchored,
      (SELECT id FROM temporal_anchors
       WHERE agent_id = $1
       ORDER BY anchor_time DESC LIMIT 1) AS latest_id,
      (SELECT anchor_hash FROM temporal_anchors
       WHERE agent_id = $1
       ORDER BY anchor_time DESC LIMIT 1) AS latest_hash,
      (SELECT anchor_time::text FROM temporal_anchors
       WHERE agent_id = $1
       ORDER BY anchor_time DESC LIMIT 1) AS latest_time
    FROM temporal_anchors
    WHERE agent_id = $1
  `, [agentId]);

  const r = result.rows[0];

  // Real integrity check: rebuild the latest anchor's Merkle root from its
  // stored per-event hashes and confirm it still equals the stored root.
  let chainIntact = false;
  if (r?.latest_id && r.latest_hash) {
    chainIntact = await verifyAnchorRoot(r.latest_id, r.latest_hash);
  }

  return {
    total_anchors: parseInt(r?.total_anchors ?? '0'),
    total_events_anchored: parseInt(r?.total_events_anchored ?? '0'),
    latest_anchor_hash: r?.latest_hash ?? null,
    latest_anchor_time: r?.latest_time ?? null,
    chain_intact: chainIntact
  };
}

// Rebuild a Merkle root from the leaves stored for one anchor and compare.
async function verifyAnchorRoot(
  anchorId: string,
  expectedRoot: string
): Promise<boolean> {
  try {
    const proofs = await query<{ event_hash: string; proof_chain: unknown }>(`
      SELECT event_hash, proof_chain
      FROM temporal_proofs
      WHERE anchor_id = $1
      ORDER BY (proof_chain->>'leaf_index')::int ASC
    `, [anchorId]);

    if (proofs.rows.length === 0) return false;

    // Only v2 anchors carry the ordering needed to rebuild the tree.
    if (!proofs.rows.every(p => isMerkleProofChain(p.proof_chain))) {
      return false;
    }

    const tree = buildMerkleTree(proofs.rows.map(p => p.event_hash));
    return tree.root === expectedRoot;
  } catch {
    return false;
  }
}
