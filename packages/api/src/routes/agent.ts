import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth } from '../auth';
import { notifyOrderEvent } from '../notifications';
import { cancelOpenOffers, dispatchConfig, dispatchOrder } from '../dispatch';
import { broadcastToOrder } from '../io';
import { getNumberFlag } from '../flags';

const FLAG_OVERRIDE_CEILING = 'max_concurrent_jobs_override_ceiling';
const DEFAULT_OVERRIDE_CEILING = 5;

// Auto-reset the per-agent extra-orders override once active load drops below
// the global cap. Keeps the toggle from leaking past the shift it was meant
// for, so the next overflow has to be opted-in again.
export async function resetExtraOrdersIfBelowCap(agentId: string): Promise<void> {
  try {
    const { rows } = await query<{ active: number; accept_extra_orders: boolean }>(
      `SELECT COUNT(o.id)::int AS active,
              MAX(CASE WHEN a.accept_extra_orders THEN 1 ELSE 0 END)::int AS accept_extra_orders
         FROM agents a
         LEFT JOIN orders o
           ON o.agent_id = a.id
          AND o.status NOT IN ('delivered','cancelled','failed')
        WHERE a.id = $1
        GROUP BY a.id`,
      [agentId],
    );
    const row = rows[0];
    if (!row) return;
    if (!row.accept_extra_orders) return;
    if (row.active < dispatchConfig.MAX_CONCURRENT_JOBS) {
      await query(
        `UPDATE agents SET accept_extra_orders = FALSE WHERE id = $1`,
        [agentId],
      );
    }
  } catch (e) {
    console.warn('[agent] resetExtraOrdersIfBelowCap failed', e);
  }
}

const router = Router();

router.get('/me', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const { rows } = await query(
    `SELECT id, phone, full_name, email, vehicle_type, vehicle_number, rating, total_deliveries, is_online, accept_extra_orders FROM agents WHERE id = $1`,
    [agentId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

router.get('/profits', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const { rows } = await query<{ date: string; amount: number }>(
    `SELECT 
       TO_CHAR(COALESCE(delivery_completed_at, created_at), 'YYYY-MM-DD') as date,
       SUM(COALESCE(service_fee, 4000)) as amount
     FROM orders 
     WHERE agent_id = $1 AND status = 'delivered'
     GROUP BY date
     ORDER BY date DESC`,
    [agentId],
  );

  const dailyProfits: Record<string, number> = {};
  let totalProfits = 0;

  rows.forEach((row) => {
    const valINR = Math.round(Number(row.amount) / 100);
    dailyProfits[row.date] = valINR;
    totalProfits += valINR;
  });

  res.json({ totalProfits, dailyProfits });
});

// Surface unified pickup/drop coordinates per order so the agent app
// can render both on one map regardless of order_type.
//   send:    pickup = pickup_address (addresses table)
//            drop   = selected courier branch (courier_branches via selected_branch_id)
//                     — agent hands the parcel to the courier office; recipient
//                     address is hand-over context only, not a routing target.
//   receive: pickup = source courier branch (courier_branches via source_branch_id)
//            drop   = delivery_address (addresses table)
const JOBS_SELECT = `
  SELECT o.*,
         COALESCE(pa.latitude, scb.latitude)               AS pickup_lat,
         COALESCE(pa.longitude, scb.longitude)             AS pickup_lng,
         COALESCE(pa.full_address, scb.full_address)       AS pickup_text,
         COALESCE(da.latitude, dcb.latitude, o.delivery_lat)        AS drop_lat,
         COALESCE(da.longitude, dcb.longitude, o.delivery_lng)      AS drop_lng,
         COALESCE(da.full_address, dcb.full_address, o.delivery_address) AS drop_text,
         dcb.name                                          AS drop_branch_name,
         dcb.phone                                         AS drop_branch_phone,
         dcb.opening_hours                                 AS drop_branch_hours,
         dc.name                                           AS selected_courier_name
    FROM orders o
    LEFT JOIN addresses pa ON pa.id = o.pickup_address_id
    LEFT JOIN addresses da ON da.id = o.delivery_address_id
    LEFT JOIN courier_branches scb ON scb.id = o.source_branch_id
    LEFT JOIN courier_branches dcb ON dcb.id = o.selected_branch_id
    LEFT JOIN couriers dc ON dc.id = o.selected_courier_id
`;

router.get('/jobs', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const { rows: assigned } = await query(
    `${JOBS_SELECT}
      WHERE o.agent_id = $1 AND o.status NOT IN ('delivered','cancelled','failed')
      ORDER BY o.created_at DESC`,
    [agentId],
  );

  const { rows: agentRows } = await query<{ is_online: boolean }>(
    `SELECT is_online FROM agents WHERE id = $1`,
    [agentId],
  );
  const isOnline = agentRows[0]?.is_online ?? false;

  // Offers: only orders the dispatcher has explicitly addressed to this
  // agent and that are still within their TTL. Offline agents see none.
  const offered = isOnline
    ? (await query(
        `SELECT o.*,
                COALESCE(pa.latitude,  scb.latitude)                AS pickup_lat,
                COALESCE(pa.longitude, scb.longitude)               AS pickup_lng,
                COALESCE(pa.full_address, scb.full_address)         AS pickup_text,
                COALESCE(da.latitude,  dcb.latitude,  o.delivery_lat)  AS drop_lat,
                COALESCE(da.longitude, dcb.longitude, o.delivery_lng) AS drop_lng,
                COALESCE(da.full_address, dcb.full_address, o.delivery_address) AS drop_text,
                dcb.name                                            AS drop_branch_name,
                dcb.phone                                           AS drop_branch_phone,
                dcb.opening_hours                                   AS drop_branch_hours,
                dc.name                                             AS selected_courier_name,
                jo.id                                               AS offer_id,
                jo.distance_m                                       AS offer_distance_m,
                jo.expires_at                                       AS offer_expires_at,
                jo.rank                                             AS offer_rank
           FROM job_offers jo
           JOIN orders o                  ON o.id   = jo.order_id
           LEFT JOIN addresses pa         ON pa.id  = o.pickup_address_id
           LEFT JOIN addresses da         ON da.id  = o.delivery_address_id
           LEFT JOIN courier_branches scb ON scb.id = o.source_branch_id
           LEFT JOIN courier_branches dcb ON dcb.id = o.selected_branch_id
           LEFT JOIN couriers dc          ON dc.id  = o.selected_courier_id
          WHERE jo.agent_id = $1
            AND jo.status = 'offered'
            AND jo.expires_at > NOW()
            AND o.agent_id IS NULL
            AND o.status = 'pending'
          ORDER BY jo.distance_m ASC`,
        [agentId],
      )).rows
    : [];

  res.json({ assigned, offered });
});

router.post('/jobs/:id/accept', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const orderId = req.params.id;

  // Must hold a live offer for this order. Without this check the targeted
  // dispatch is trivially bypassed by hitting accept on any open order id.
  const { rows: offerRows } = await query<{ id: string }>(
    `SELECT id FROM job_offers
       WHERE order_id = $1 AND agent_id = $2 AND status = 'offered' AND expires_at > NOW()
       ORDER BY offered_at DESC LIMIT 1`,
    [orderId, agentId],
  );
  if (offerRows.length === 0) return res.status(403).json({ error: 'no_offer' });

  // Concurrent-job cap. Default cap is MAX_CONCURRENT_JOBS (=2). Agents who
  // have toggled `accept_extra_orders` ON get the admin-configured override
  // ceiling instead — which still bounds them, so the override isn't unlimited.
  const { rows: loadRows } = await query<{ active: number; accept_extra_orders: boolean }>(
    `SELECT
        (SELECT COUNT(*)::int FROM orders
           WHERE agent_id = $1 AND status NOT IN ('delivered','cancelled','failed')) AS active,
        accept_extra_orders
       FROM agents WHERE id = $1`,
    [agentId],
  );
  const active = loadRows[0]?.active ?? 0;
  const acceptsExtra = loadRows[0]?.accept_extra_orders ?? false;
  const effectiveCap = acceptsExtra
    ? await getNumberFlag(FLAG_OVERRIDE_CEILING, DEFAULT_OVERRIDE_CEILING)
    : dispatchConfig.MAX_CONCURRENT_JOBS;
  if (active >= effectiveCap) {
    return res.status(409).json({ error: 'concurrent_cap_reached' });
  }

  const { rows } = await query(
    `UPDATE orders SET agent_id = $1, status = 'agent_assigned', updated_at = NOW()
       WHERE id = $2 AND agent_id IS NULL AND status = 'pending'
       RETURNING *`,
    [agentId, orderId],
  );
  if (rows.length === 0) return res.status(409).json({ error: 'job_unavailable' });

  // Win the offer and cancel siblings so the other addressees stop seeing it.
  await query(
    `UPDATE job_offers SET status = 'accepted', resolved_at = NOW()
       WHERE id = $1`,
    [offerRows[0].id],
  );
  await cancelOpenOffers(orderId, agentId);

  await query(
    `INSERT INTO order_status_history (order_id, status, changed_by_type, changed_by_id) VALUES ($1, 'agent_assigned', 'agent', $2)`,
    [orderId, agentId],
  );
  notifyOrderEvent(orderId, 'agent_assigned');
  res.json(rows[0]);
});

router.post('/jobs/:id/decline', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const orderId = req.params.id;
  const { rowCount } = await query(
    `UPDATE job_offers SET status = 'declined', resolved_at = NOW()
       WHERE order_id = $1 AND agent_id = $2 AND status = 'offered'`,
    [orderId, agentId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'no_offer' });

  // Fire-and-forget re-dispatch so the freed slot gets backfilled with the
  // next-nearest eligible agent. The sweeper would catch it within 10s
  // anyway; doing it now keeps the queue snappy when an agent is browsing.
  void dispatchOrder(orderId);

  res.json({ ok: true });
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  agent_assigned: ['agent_en_route_pickup', 'failed'],
  agent_en_route_pickup: ['parcel_collected', 'failed'],
  parcel_collected: ['out_for_delivery', 'failed'],
  out_for_delivery: ['delivered', 'failed'],
};

router.post('/jobs/:id/update-status', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const schema = z.object({
    status: z.string(),
    notes: z.string().optional(),
    photo_url: z.string().url().optional(),
    location: z.object({ lat: z.number(), lng: z.number() }).optional(),
    delivery_otp: z.string().length(4).optional(),
    failure_reason: z.string().min(1).max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { status, notes, photo_url, delivery_otp, failure_reason } = parsed.data;

  if (status === 'failed' && !failure_reason) {
    return res.status(400).json({ error: 'failure_reason_required' });
  }

  const { rows: orderRows } = await query<{ status: string; delivery_otp: string; order_type: string }>(
    `SELECT status, delivery_otp, order_type FROM orders WHERE id = $1 AND agent_id = $2`,
    [req.params.id, agentId],
  );
  if (orderRows.length === 0) return res.status(404).json({ error: 'not_found' });
  const current = orderRows[0].status;
  const allowed = ALLOWED_TRANSITIONS[current] ?? [];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'invalid_transition', from: current, to: status });
  }

  // OTP gate: customer holds the OTP at the parcel-handover moment.
  // Send: handover is at pickup (parcel_collected). Receive: at delivery (delivered).
  const otpRequired =
    (orderRows[0].order_type === 'send' && status === 'parcel_collected') ||
    (orderRows[0].order_type === 'receive' && status === 'delivered');
  if (otpRequired) {
    if (!delivery_otp || delivery_otp !== orderRows[0].delivery_otp) {
      return res.status(401).json({ error: 'otp_mismatch' });
    }
  }

  const photoColumn =
    status === 'parcel_collected' ? 'pickup_proof_photo_url' :
    status === 'delivered' ? 'delivery_proof_photo_url' : null;

  const sets: string[] = ['status = $1', 'updated_at = NOW()'];
  const params: any[] = [status];
  if (photoColumn && photo_url) {
    params.push(photo_url);
    sets.push(`${photoColumn} = $${params.length}`);
  }
  if (status === 'parcel_collected') sets.push(`pickup_completed_at = NOW()`);
  if (status === 'delivered') sets.push(`delivery_completed_at = NOW()`);
  if (status === 'failed' && failure_reason) {
    params.push(failure_reason);
    sets.push(`failure_reason = $${params.length}`);
  }

  params.push(req.params.id);
  await query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

  await query(
    `INSERT INTO order_status_history (order_id, status, notes, changed_by_type, changed_by_id) VALUES ($1, $2, $3, 'agent', $4)`,
    [req.params.id, status, notes ?? failure_reason ?? null, agentId],
  );

  if (status === 'delivered') {
    await query(
      `UPDATE agents SET total_deliveries = total_deliveries + 1 WHERE id = $1`,
      [agentId],
    );
  }

  // Once the agent's load drops below the global cap, reset their per-shift
  // override so they have to opt-in again the next time they're at the ceiling.
  if (status === 'delivered' || status === 'failed') {
    await resetExtraOrdersIfBelowCap(agentId);
  }

  notifyOrderEvent(req.params.id, status as any);
  res.json({ ok: true, status });
});

router.post('/location', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const parsed = z.object({ lat: z.number(), lng: z.number() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  
  const { lat, lng } = parsed.data;
  
  await query(
    `UPDATE agents SET current_lat = $1, current_lng = $2, last_location_at = NOW() WHERE id = $3`,
    [lat, lng, agentId],
  );

  // Retrieve active in-flight jobs assigned to this agent to push telemetry to the tracking rooms
  try {
    const { rows: activeJobs } = await query<{ id: string }>(
      `SELECT id FROM orders 
        WHERE agent_id = $1 
          AND status NOT IN ('delivered', 'cancelled', 'failed')`,
      [agentId]
    );
    for (const job of activeJobs) {
      broadcastToOrder(job.id, 'location_received', { lat, lng, agentId });
    }
  } catch (err) {
    console.error(`[agent:location] failed to broadcast telemetry`, err);
  }

  res.json({ ok: true });
});

// Device-token registration for FCM pushes. Called from the agent app right
// after sign-in and on token rotation. Upsert on (token) — if the device
// is re-used by a different agent the row moves to the new owner.
router.post('/device-token', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const parsed = z.object({
    token: z.string().min(20),
    platform: z.enum(['android', 'ios']),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await query(
    `INSERT INTO agent_devices (agent_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET agent_id = EXCLUDED.agent_id,
                                          platform = EXCLUDED.platform,
                                          updated_at = NOW()`,
    [agentId, parsed.data.token, parsed.data.platform],
  );
  res.json({ ok: true });
});

router.delete('/device-token', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const parsed = z.object({ token: z.string().min(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await query(`DELETE FROM agent_devices WHERE token = $1 AND agent_id = $2`,
    [parsed.data.token, agentId]);
  res.json({ ok: true });
});

router.post('/online-status', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const parsed = z.object({ is_online: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await query(`UPDATE agents SET is_online = $1 WHERE id = $2`, [parsed.data.is_online, agentId]);
  // Going offline auto-drops the override so a re-online doesn't surprise the
  // agent with an unexpected overflow.
  if (!parsed.data.is_online) {
    await query(`UPDATE agents SET accept_extra_orders = FALSE WHERE id = $1`, [agentId]);
  }
  res.json({ ok: true });
});

// Per-shift override of the global dispatch cap. Turning ON requires the
// agent to be online AND already at-or-past the global cap — the feature
// exists to opt into overflow, not to pre-stage extra capacity. Turning OFF
// is always allowed.
router.post('/accept-extra-orders', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  if (parsed.data.enabled) {
    const { rows } = await query<{ is_online: boolean; active: number }>(
      `SELECT a.is_online,
              (SELECT COUNT(*)::int FROM orders
                 WHERE agent_id = a.id
                   AND status NOT IN ('delivered','cancelled','failed')) AS active
         FROM agents a WHERE a.id = $1`,
      [agentId],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!row.is_online) return res.status(409).json({ error: 'must_be_online' });
    if (row.active < dispatchConfig.MAX_CONCURRENT_JOBS) {
      return res.status(409).json({ error: 'below_cap' });
    }
  }

  await query(
    `UPDATE agents SET accept_extra_orders = $1 WHERE id = $2`,
    [parsed.data.enabled, agentId],
  );
  res.json({ ok: true, accept_extra_orders: parsed.data.enabled });
});

// Job history — completed / cancelled / failed orders for the driver profile page
router.get('/history', requireAuth(['agent']), async (req, res) => {
  const agentId = (req.principal as any).agentId;
  const limitRaw = Number(req.query.limit) || 50;
  const offsetRaw = Number(req.query.offset) || 0;
  const limit = Math.min(Math.max(1, limitRaw), 100);
  const offset = Math.max(0, offsetRaw);

  const { rows } = await query(
    `${JOBS_SELECT}
      WHERE o.agent_id = $1 AND o.status IN ('delivered', 'cancelled', 'failed')
      ORDER BY o.updated_at DESC
      LIMIT $2 OFFSET $3`,
    [agentId, limit, offset],
  );

  const { rows: countRows } = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM orders WHERE agent_id = $1 AND status IN ('delivered', 'cancelled', 'failed')`,
    [agentId],
  );

  res.json({ orders: rows, total: Number(countRows[0]?.total ?? 0) });
});

export default router;
