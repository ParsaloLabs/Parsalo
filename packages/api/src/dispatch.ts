// Order → agent dispatch.
//
// Behaviour: a new paid order gets offered in parallel to up to N=3 of the
// nearest eligible online agents inside a widening radius ladder. Each offer
// lives for OFFER_TTL_SECONDS; if every offer in a round expires or is declined
// the next attempt widens the radius. After the ladder is exhausted we fall
// back to "every online agent" so an order is never stranded as long as anyone
// is online.
//
// Eligibility:
//   * agents.status = 'approved' AND is_active AND is_online
//   * fresh location (last_location_at within LOCATION_FRESHNESS_MINUTES)
//   * fewer than MAX_CONCURRENT_JOBS active assignments
//   * not already holding a live offer for this order
//   * for the no-radius fallback we waive the location-freshness rule so
//     orders still find takers when GPS pings are flaky
//
// Chained recommendations:
//   * agents with an active job are still eligible (up to the cap) but are
//     scored from their drop-off location (where they'll next be free) with a
//     BUSY_PENALTY multiplier so a truly-free agent nearby still wins ties.

import { query } from './db';
import { sendPushToAgent } from './push';
import { getNumberFlag } from './flags';

const FLAG_OVERRIDE_CEILING = 'max_concurrent_jobs_override_ceiling';
const DEFAULT_OVERRIDE_CEILING = 5;

// Tunable at runtime via the admin panel (table: dispatch_config).
// Defaults match the table's column defaults so a missing row degrades sanely.
const DEFAULT_OFFER_TTL_SECONDS = 30;
const DEFAULT_INITIAL_RADIUS_M = 5_000;

// Fixed for now; can be promoted to dispatch_config if/when we need to tune.
const PARALLEL_OFFERS = 3;
const MAX_CONCURRENT_JOBS = 2;
const LOCATION_FRESHNESS_MINUTES = 10;
const BUSY_PENALTY = 1.3;

type RuntimeConfig = {
  offerTtlSeconds: number;
  initialRadiusM: number;
  radiusLadderM: Array<number | null>;
};

// Tiny in-process cache so a hot sweeper doesn't hammer the DB. Invalidated
// from the admin save path so changes show up instantly in dev.
const CONFIG_CACHE_MS = 10_000;
let cachedConfig: { value: RuntimeConfig; loadedAt: number } | null = null;

export function invalidateDispatchConfigCache(): void {
  cachedConfig = null;
}

async function loadConfig(): Promise<RuntimeConfig> {
  if (cachedConfig && Date.now() - cachedConfig.loadedAt < CONFIG_CACHE_MS) {
    return cachedConfig.value;
  }
  let initialRadiusM = DEFAULT_INITIAL_RADIUS_M;
  let offerTtlSeconds = DEFAULT_OFFER_TTL_SECONDS;
  try {
    const { rows } = await query<{ initial_radius_m: number; offer_ttl_seconds: number }>(
      `SELECT initial_radius_m, offer_ttl_seconds FROM dispatch_config WHERE id = 1`,
    );
    if (rows[0]) {
      initialRadiusM = rows[0].initial_radius_m;
      offerTtlSeconds = rows[0].offer_ttl_seconds;
    }
  } catch (e) {
    // Table missing (pre-migration) — fall back to defaults so dispatch still runs.
    console.warn('[dispatch] config load failed, using defaults', e);
  }
  const value: RuntimeConfig = {
    offerTtlSeconds,
    initialRadiusM,
    radiusLadderM: [initialRadiusM, initialRadiusM * 2, initialRadiusM * 3, null],
  };
  cachedConfig = { value, loadedAt: Date.now() };
  return value;
}

type DispatchOrder = {
  id: string;
  order_code: string;
  order_type: 'send' | 'receive';
  total_amount: number;
  pickup_lat: number;
  pickup_lng: number;
  status: string;
  payment_status: string;
  agent_id: string | null;
  dispatch_attempts: number;
};

// Resolve the unified pickup coords for an order regardless of order_type.
// send:    pickup is the customer's pickup_address.
// receive: pickup is the source courier branch.
async function loadOrderForDispatch(orderId: string): Promise<DispatchOrder | null> {
  const { rows } = await query<DispatchOrder>(
    `SELECT o.id, o.order_code, o.order_type, o.total_amount,
            o.status, o.payment_status, o.agent_id, o.dispatch_attempts,
            COALESCE(pa.latitude,  scb.latitude)::float8  AS pickup_lat,
            COALESCE(pa.longitude, scb.longitude)::float8 AS pickup_lng
       FROM orders o
       LEFT JOIN addresses pa        ON pa.id  = o.pickup_address_id
       LEFT JOIN courier_branches scb ON scb.id = o.source_branch_id
      WHERE o.id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

type Candidate = {
  agent_id: string;
  distance_m: number;       // score-distance (with busy penalty applied)
  raw_distance_m: number;   // actual metres for UI display
  active_jobs: number;
};

// Pick the nearest eligible agents inside the given radius. Returns up to N
// candidates sorted by ascending score-distance.
async function pickCandidates(
  order: DispatchOrder,
  radiusM: number | null,
  limit: number,
): Promise<Candidate[]> {
  // Subquery: each agent's active-job count + next-free location.
  // If they have ≥1 active job, score them from the drop point of the most
  // recent active assignment; otherwise from their current GPS ping.
  // $3 = global cap, $5 = admin-configured override ceiling for agents who
  // opted into accept_extra_orders.
  const overrideCeiling = await getNumberFlag(FLAG_OVERRIDE_CEILING, DEFAULT_OVERRIDE_CEILING);
  const params: any[] = [order.pickup_lat, order.pickup_lng, MAX_CONCURRENT_JOBS, order.id, overrideCeiling];
  const radiusClause = radiusM === null
    ? ''
    : `AND score_distance_m <= $${params.push(radiusM)}`;
  const freshnessClause = radiusM === null
    ? '' // fallback widens to everyone online, even with stale GPS
    : `AND a.last_location_at IS NOT NULL
       AND a.last_location_at > NOW() - INTERVAL '${LOCATION_FRESHNESS_MINUTES} minutes'`;

  const sql = `
    WITH agent_load AS (
      SELECT a.id AS agent_id,
             a.current_lat::float8  AS cur_lat,
             a.current_lng::float8  AS cur_lng,
             a.accept_extra_orders  AS accept_extra,
             COUNT(o.id)::int       AS active_jobs,
             -- next-free location: drop coords of the most-recent active job,
             -- falling back to the agent's current GPS if no active job.
             COALESCE(
               (SELECT COALESCE(da.latitude,  dcb.latitude, o2.delivery_lat)::float8
                  FROM orders o2
                  LEFT JOIN addresses da         ON da.id  = o2.delivery_address_id
                  LEFT JOIN courier_branches dcb ON dcb.id = o2.selected_branch_id
                 WHERE o2.agent_id = a.id
                   AND o2.status NOT IN ('delivered','cancelled','failed')
                 ORDER BY o2.created_at DESC LIMIT 1),
               a.current_lat::float8
             ) AS free_lat,
             COALESCE(
               (SELECT COALESCE(da.longitude, dcb.longitude, o2.delivery_lng)::float8
                  FROM orders o2
                  LEFT JOIN addresses da         ON da.id  = o2.delivery_address_id
                  LEFT JOIN courier_branches dcb ON dcb.id = o2.selected_branch_id
                 WHERE o2.agent_id = a.id
                   AND o2.status NOT IN ('delivered','cancelled','failed')
                 ORDER BY o2.created_at DESC LIMIT 1),
               a.current_lng::float8
             ) AS free_lng
        FROM agents a
        LEFT JOIN orders o
          ON o.agent_id = a.id
         AND o.status NOT IN ('delivered','cancelled','failed')
       WHERE a.is_online = TRUE
         AND a.is_active = TRUE
         AND a.status = 'approved'
         ${freshnessClause}
       GROUP BY a.id
    )
    SELECT agent_id,
           active_jobs,
           accept_extra,
           -- Haversine in metres against the order pickup.
           (
             2 * 6371000 * ASIN(
               SQRT(
                 POWER(SIN(RADIANS(($1 - free_lat) / 2)), 2)
                 + COS(RADIANS(free_lat)) * COS(RADIANS($1))
                 * POWER(SIN(RADIANS(($2 - free_lng) / 2)), 2)
               )
             )
           )::int AS raw_distance_m,
           -- Score distance: busy agents get penalised. Free agents keep raw.
           (
             2 * 6371000 * ASIN(
               SQRT(
                 POWER(SIN(RADIANS(($1 - free_lat) / 2)), 2)
                 + COS(RADIANS(free_lat)) * COS(RADIANS($1))
                 * POWER(SIN(RADIANS(($2 - free_lng) / 2)), 2)
               )
             )
             * CASE WHEN active_jobs > 0 THEN ${BUSY_PENALTY} ELSE 1 END
           )::int AS score_distance_m
      FROM agent_load
     WHERE (active_jobs < $3 OR (accept_extra = TRUE AND active_jobs < $5))
       AND agent_id NOT IN (
         SELECT agent_id FROM job_offers
          WHERE order_id = $4 AND status = 'offered'
       )
  `;

  // We need to filter on the computed alias `score_distance_m`. Postgres
  // requires wrapping the SELECT in a subquery to reference the alias in WHERE.
  const wrapped = `
    SELECT * FROM (${sql}) ranked
     WHERE 1 = 1 ${radiusClause}
     ORDER BY score_distance_m ASC
     LIMIT $${params.push(limit)}
  `;

  const { rows } = await query<{
    agent_id: string;
    raw_distance_m: number;
    score_distance_m: number;
    active_jobs: number;
  }>(wrapped, params);

  return rows.map((r) => ({
    agent_id: r.agent_id,
    distance_m: r.score_distance_m,
    raw_distance_m: r.raw_distance_m,
    active_jobs: r.active_jobs,
  }));
}

async function pushOffer(
  agentId: string,
  order: DispatchOrder,
  distanceM: number,
) {
  await sendPushToAgent(agentId, {
    title: `New offer · ${(distanceM / 1000).toFixed(1)} km`,
    body: `${order.order_type === 'send' ? 'Dispatch send' : 'Partner collect'} ${order.order_code} · ₹${Math.round(order.total_amount / 100)}`,
    data: { orderId: order.id, kind: 'offer' },
  });
}

// Main entry. Called after payment success and from the sweeper.
// Returns the number of offers created in this round.
export async function dispatchOrder(orderId: string): Promise<number> {
  const order = await loadOrderForDispatch(orderId);
  if (!order) return 0;

  // Idempotency guards.
  if (order.status !== 'pending') return 0;
  if (order.payment_status !== 'paid') return 0;
  if (order.agent_id) return 0;
  if (order.pickup_lat == null || order.pickup_lng == null) {
    console.warn(`[dispatch] order ${order.order_code} has no pickup coords — skipping`);
    return 0;
  }

  const cfg = await loadConfig();

  // Pick the radius for this attempt. Caller's attempts counter is stored on
  // the order; the ladder index is min(attempts, ladder length - 1) so we land
  // on the open-pool fallback once attempts >= ladder length.
  const ladderIdx = Math.min(order.dispatch_attempts, cfg.radiusLadderM.length - 1);
  const radiusM = cfg.radiusLadderM[ladderIdx];
  const attemptNumber = order.dispatch_attempts + 1;

  const candidates = await pickCandidates(order, radiusM, PARALLEL_OFFERS);

  // Always increment the attempts counter so the next sweep walks the ladder
  // even if this attempt produced zero candidates (e.g. nobody online inside
  // the inner radius).
  await query(
    `UPDATE orders SET dispatch_attempts = dispatch_attempts + 1, dispatch_last_at = NOW() WHERE id = $1`,
    [order.id],
  );

  if (candidates.length === 0) {
    console.log(`[dispatch] ${order.order_code} attempt ${attemptNumber} radius=${radiusM ?? 'ALL'}m → no candidates`);
    return 0;
  }

  const expiresAt = new Date(Date.now() + cfg.offerTtlSeconds * 1000);
  await Promise.all(
    candidates.map((c, idx) =>
      query(
        `INSERT INTO job_offers (order_id, agent_id, distance_m, rank, attempt, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (order_id, agent_id) WHERE status = 'offered' DO NOTHING`,
        [order.id, c.agent_id, c.raw_distance_m, idx + 1, attemptNumber, expiresAt],
      ),
    ),
  );

  // Fire pushes after the DB writes commit so an agent who opens the app from
  // the push always sees the offer in /agent/jobs.
  await Promise.all(candidates.map((c) => pushOffer(c.agent_id, order, c.raw_distance_m)));

  console.log(
    `[dispatch] ${order.order_code} attempt ${attemptNumber} radius=${radiusM ?? 'ALL'}m → ${candidates.length} offer(s)`,
  );
  return candidates.length;
}

// Mark live offers as expired once they pass expires_at. Called from the sweeper.
export async function expireStaleOffers(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE job_offers
        SET status = 'expired', resolved_at = NOW()
      WHERE status = 'offered' AND expires_at <= NOW()`,
  );
  return rowCount ?? 0;
}

// Find paid+pending+unassigned orders that have no live offers and either
// have never been dispatched or whose last attempt is finished. Each returned
// order is a candidate for the next dispatch round.
export async function findOrdersAwaitingDispatch(): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT o.id
       FROM orders o
      WHERE o.status = 'pending'
        AND o.payment_status = 'paid'
        AND o.agent_id IS NULL
        AND (o.retry_at IS NULL OR o.retry_at <= NOW())
        AND NOT EXISTS (
          SELECT 1 FROM job_offers
           WHERE order_id = o.id AND status = 'offered'
        )
        -- 2s settle window so we don't re-dispatch the same order on
        -- back-to-back sweeper ticks while the previous round is in flight.
        AND (o.dispatch_last_at IS NULL OR o.dispatch_last_at < NOW() - INTERVAL '2 seconds')
      ORDER BY o.created_at ASC
      LIMIT 100`,
  );
  return rows.map((r) => r.id);
}

// Top-level tick called by the background interval in src/index.ts.
export async function dispatchSweep(): Promise<void> {
  try {
    const expired = await expireStaleOffers();
    const ids = await findOrdersAwaitingDispatch();
    if (expired === 0 && ids.length === 0) return;
    for (const id of ids) {
      // Sequential so we don't slam the DB on a backlog. Each dispatch is fast.
      await dispatchOrder(id);
    }
  } catch (e) {
    console.warn('[dispatch:sweep] failed', e);
  }
}

// Cancel any live offers for an order — used when accept wins, or on cancel.
export async function cancelOpenOffers(orderId: string, exceptAgentId?: string): Promise<void> {
  if (exceptAgentId) {
    await query(
      `UPDATE job_offers SET status = 'cancelled', resolved_at = NOW()
         WHERE order_id = $1 AND status = 'offered' AND agent_id <> $2`,
      [orderId, exceptAgentId],
    );
  } else {
    await query(
      `UPDATE job_offers SET status = 'cancelled', resolved_at = NOW()
         WHERE order_id = $1 AND status = 'offered'`,
      [orderId],
    );
  }
}

export const dispatchConfig = {
  PARALLEL_OFFERS,
  MAX_CONCURRENT_JOBS,
  LOCATION_FRESHNESS_MINUTES,
  BUSY_PENALTY,
  loadRuntime: loadConfig,
};
