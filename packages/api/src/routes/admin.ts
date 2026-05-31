import { Router } from 'express';
import bcrypt from 'bcryptjs';
import Razorpay from 'razorpay';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth } from '../auth';
import { env } from '../env';
import { notifyOrderEvent } from '../notifications';
import { invalidateDispatchConfigCache } from '../dispatch';
import { invalidateServiceAreaCache } from '../serviceArea';
import { getAllFlags, setFlag } from '../flags';

const router = Router();

const razorpay = env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET })
  : null;

router.get('/orders', requireAuth(['admin']), async (req, res) => {
  const status = req.query.status as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const params: any[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE o.status = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT o.*, u.phone AS user_phone, u.full_name AS user_name, a.full_name AS agent_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN agents a ON a.id = o.agent_id
       ${where}
       ORDER BY o.created_at DESC LIMIT $${params.length}`,
    params,
  );
  res.json(rows);
});

router.post('/orders/:id/assign-agent', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = z.object({ agent_id: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { rows } = await query(
    `UPDATE orders SET agent_id = $1, status = 'agent_assigned', updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
    [parsed.data.agent_id, req.params.id],
  );
  if (rows.length === 0) return res.status(409).json({ error: 'cannot_assign' });
  await query(
    `INSERT INTO order_status_history (order_id, status, changed_by_type, changed_by_id) VALUES ($1, 'agent_assigned', 'admin', $2)`,
    [req.params.id, adminId],
  );
  res.json(rows[0]);
});

router.get('/agents', requireAuth(['admin']), async (_req, res) => {
  const { rows } = await query(
    `SELECT id, phone, full_name, vehicle_type, vehicle_number, status, is_online, is_active, rating, total_deliveries, current_lat, current_lng
       FROM agents WHERE status = 'approved' ORDER BY created_at DESC`,
  );
  res.json(rows);
});

router.post('/agents', requireAuth(['admin']), async (req, res) => {
  const schema = z.object({
    phone: z.string().min(10),
    full_name: z.string().min(1),
    email: z.string().email().optional(),
    password: z.string().min(6),
    vehicle_type: z.enum(['bike', 'scooter']).optional(),
    vehicle_number: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const a = parsed.data;
  const hash = await bcrypt.hash(a.password, 10);
  const { rows } = await query(
    `INSERT INTO agents (phone, full_name, email, password_hash, vehicle_type, vehicle_number, status, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved', TRUE) RETURNING id, phone, full_name`,
    [a.phone, a.full_name, a.email ?? null, hash, a.vehicle_type ?? null, a.vehicle_number ?? null],
  );
  res.status(201).json(rows[0]);
});

router.get('/agents/pending', requireAuth(['admin']), async (_req, res) => {
  const { rows } = await query(
    `SELECT id, phone, full_name, email, vehicle_type, vehicle_number, dl_number, city, status, rejection_reason, created_at
       FROM agents WHERE status IN ('pending', 'rejected') ORDER BY created_at DESC`,
  );
  res.json(rows);
});

router.post('/agents/:id/approve', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const { rows } = await query(
    `UPDATE agents
        SET status = 'approved', is_active = TRUE, rejection_reason = NULL,
            reviewed_at = NOW(), reviewed_by = $1
      WHERE id = $2 AND status IN ('pending', 'rejected')
      RETURNING id, status`,
    [adminId, req.params.id],
  );
  if (rows.length === 0) return res.status(409).json({ error: 'cannot_approve' });
  res.json(rows[0]);
});

router.post('/agents/:id/reject', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { rows } = await query(
    `UPDATE agents
        SET status = 'rejected', is_active = FALSE, rejection_reason = $1,
            reviewed_at = NOW(), reviewed_by = $2
      WHERE id = $3 AND status = 'pending'
      RETURNING id, status`,
    [parsed.data.reason, adminId, req.params.id],
  );
  if (rows.length === 0) return res.status(409).json({ error: 'cannot_reject' });
  res.json(rows[0]);
});

// Re-queue a failed order. `when='today'` makes it immediately available again;
// `when='tomorrow'` schedules for next morning IST.
router.post('/orders/:id/retry', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = z.object({ when: z.enum(['today', 'tomorrow']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const retryAtSql = parsed.data.when === 'today'
    ? 'NULL'
    : `(DATE_TRUNC('day', (NOW() AT TIME ZONE 'Asia/Kolkata')) + INTERVAL '1 day 9 hours') AT TIME ZONE 'Asia/Kolkata'`;
  const { rows } = await query(
    `UPDATE orders
        SET status = 'pending', agent_id = NULL,
            retry_at = ${retryAtSql},
            failure_reason = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status = 'failed'
      RETURNING id, retry_at`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(409).json({ error: 'not_failed' });
  await query(
    `INSERT INTO order_status_history (order_id, status, notes, changed_by_type, changed_by_id)
       VALUES ($1, 'pending', $2, 'admin', $3)`,
    [req.params.id, `admin re-queued (${parsed.data.when})`, adminId],
  );
  res.json({ ok: true, retry_at: rows[0].retry_at });
});

// Refund a failed order — full or partial. Razorpay refund in prod, short-circuit in dev.
router.post('/orders/:id/refund', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = z.object({ amount_paise: z.number().int().positive().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const { rows } = await query<{
    id: string; total_amount: number; payment_id: string | null; payment_status: string; status: string;
  }>(
    `SELECT id, total_amount, payment_id, payment_status, status FROM orders WHERE id = $1`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const order = rows[0];
  if (order.status !== 'failed') return res.status(409).json({ error: 'not_failed' });
  if (order.payment_status === 'refunded') return res.status(409).json({ error: 'already_refunded' });

  const amount = parsed.data.amount_paise ?? order.total_amount;
  if (amount > order.total_amount) return res.status(400).json({ error: 'amount_exceeds_total' });

  if (razorpay && order.payment_status === 'paid' && order.payment_id && order.payment_id !== 'dev_mock_payment') {
    try {
      await razorpay.payments.refund(order.payment_id, { amount, speed: 'normal' });
    } catch (e: any) {
      return res.status(502).json({ error: 'razorpay_refund_failed', message: e?.message });
    }
  }

  await query(
    `UPDATE orders SET payment_status = 'refunded', refund_amount_paise = $1, updated_at = NOW() WHERE id = $2`,
    [amount, order.id],
  );
  await query(
    `INSERT INTO order_status_history (order_id, status, notes, changed_by_type, changed_by_id)
       VALUES ($1, 'failed', $2, 'admin', $3)`,
    [order.id, `refunded ${amount} paise${amount === order.total_amount ? ' (full)' : ' (partial)'}`, adminId],
  );
  notifyOrderEvent(order.id, 'cancelled');
  res.json({ ok: true, refund_amount_paise: amount });
});

router.get('/dashboard-stats', requireAuth(['admin']), async (_req, res) => {
  const today = `DATE_TRUNC('day', NOW())`;
  const { rows } = await query<{
    orders_today: number; active_orders: number; agents_online: number;
    revenue_today_paise: number; failed_count: number; refund_requested_count: number;
    registered_users: number; total_agents: number;
  }>(
    `SELECT
      (SELECT COUNT(*)::int FROM orders WHERE created_at >= ${today}) AS orders_today,
      (SELECT COUNT(*)::int FROM orders WHERE status NOT IN ('delivered','cancelled','failed')) AS active_orders,
      (SELECT COUNT(*)::int FROM agents WHERE is_online = TRUE) AS agents_online,
      (SELECT COALESCE(SUM(total_amount), 0)::int FROM orders WHERE created_at >= ${today} AND payment_status = 'paid') AS revenue_today_paise,
      (SELECT COUNT(*)::int FROM orders WHERE status = 'failed' AND (payment_status IS NULL OR payment_status NOT IN ('refunded','refund_requested'))) AS failed_count,
      (SELECT COUNT(*)::int FROM orders WHERE payment_status = 'refund_requested') AS refund_requested_count,
      (SELECT COUNT(*)::int FROM users) AS registered_users,
      (SELECT COUNT(*)::int FROM agents) AS total_agents
    `,
  );
  res.json(rows[0]);
});

// Dispatch tunables — initial search radius and per-offer TTL.
// Ladder used at runtime is derived as [r, 2r, 3r, null].
router.get('/dispatch-config', requireAuth(['admin']), async (_req, res) => {
  const { rows } = await query<{
    initial_radius_m: number;
    offer_ttl_seconds: number;
    updated_at: string;
  }>(`SELECT initial_radius_m, offer_ttl_seconds, updated_at FROM dispatch_config WHERE id = 1`);
  if (rows.length === 0) return res.status(500).json({ error: 'config_missing' });
  res.json(rows[0]);
});

const dispatchConfigSchema = z.object({
  initial_radius_m: z.number().int().min(100).max(200_000),
  offer_ttl_seconds: z.number().int().min(5).max(600),
});

router.post('/dispatch-config', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = dispatchConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', issues: parsed.error.issues });
  const { initial_radius_m, offer_ttl_seconds } = parsed.data;
  const { rows } = await query<{
    initial_radius_m: number;
    offer_ttl_seconds: number;
    updated_at: string;
  }>(
    `UPDATE dispatch_config
        SET initial_radius_m = $1,
            offer_ttl_seconds = $2,
            updated_at = NOW(),
            updated_by = $3
      WHERE id = 1
      RETURNING initial_radius_m, offer_ttl_seconds, updated_at`,
    [initial_radius_m, offer_ttl_seconds, adminId],
  );
  invalidateDispatchConfigCache();
  res.json(rows[0]);
});

// Service areas — admin can add/edit/disable zones where Parsalo agents operate.
// Order-create gates pickup (send) / delivery (receive) against active rows.
router.get('/service-areas', requireAuth(['admin']), async (_req, res) => {
  const { rows } = await query<{
    id: string;
    name: string;
    center_lat: string;
    center_lng: string;
    radius_m: number;
    is_active: boolean;
    updated_at: string;
  }>(
    `SELECT id, name, center_lat, center_lng, radius_m, is_active, updated_at
       FROM service_areas
       ORDER BY name`,
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      center_lat: Number(r.center_lat),
      center_lng: Number(r.center_lng),
      radius_m: r.radius_m,
      is_active: r.is_active,
      updated_at: r.updated_at,
    })),
  );
});

const serviceAreaSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(60),
  center_lat: z.number().min(-90).max(90),
  center_lng: z.number().min(-180).max(180),
  radius_m: z.number().int().min(500).max(200_000),
  is_active: z.boolean().optional().default(true),
});

router.post('/service-areas', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = serviceAreaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', issues: parsed.error.issues });
  const { id, name, center_lat, center_lng, radius_m, is_active } = parsed.data;

  const { rows } = id
    ? await query<{ id: string }>(
        `UPDATE service_areas
            SET name = $1, center_lat = $2, center_lng = $3, radius_m = $4,
                is_active = $5, updated_at = NOW(), updated_by = $6
          WHERE id = $7
          RETURNING id`,
        [name, center_lat, center_lng, radius_m, is_active, adminId, id],
      )
    : await query<{ id: string }>(
        `INSERT INTO service_areas (name, center_lat, center_lng, radius_m, is_active, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, center_lat, center_lng, radius_m, is_active, adminId],
      );

  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  invalidateServiceAreaCache();
  res.json({ id: rows[0].id });
});

router.delete('/service-areas/:id', requireAuth(['admin']), async (req, res) => {
  const { rowCount } = await query(`DELETE FROM service_areas WHERE id = $1`, [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  invalidateServiceAreaCache();
  res.json({ ok: true });
});

// Courier branches — physical offices (DTDC Round North etc.) that customers
// can choose as the drop point for send orders. Admin maintains the list;
// customer flow ranks them by distance from the pickup pin at order time.
router.get('/courier-branches', requireAuth(['admin']), async (_req, res) => {
  const { rows } = await query<{
    id: string;
    courier_id: string;
    courier_name: string;
    name: string | null;
    district: string | null;
    full_address: string;
    latitude: string | null;
    longitude: string | null;
    pincode: string | null;
    phone: string | null;
    opening_hours: string | null;
  }>(
    `SELECT b.id, b.courier_id, c.name AS courier_name, b.name, b.district,
            b.full_address, b.latitude, b.longitude, b.pincode, b.phone, b.opening_hours
       FROM courier_branches b
       JOIN couriers c ON c.id = b.courier_id
      ORDER BY c.name, b.district NULLS LAST, b.name NULLS LAST`,
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      courier_id: r.courier_id,
      courier_name: r.courier_name,
      name: r.name,
      district: r.district,
      full_address: r.full_address,
      latitude: r.latitude !== null ? Number(r.latitude) : null,
      longitude: r.longitude !== null ? Number(r.longitude) : null,
      pincode: r.pincode,
      phone: r.phone,
      opening_hours: r.opening_hours,
    })),
  );
});

const courierBranchSchema = z.object({
  id: z.string().uuid().optional(),
  courier_id: z.string().uuid(),
  name: z.string().trim().min(2).max(255),
  district: z.string().trim().min(2).max(80),
  full_address: z.string().trim().min(5).max(500),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  pincode: z.string().trim().regex(/^\d{6}$/),
  phone: z.string().trim().max(15).optional().or(z.literal('')),
  opening_hours: z.string().trim().max(120).optional().or(z.literal('')),
});

router.post('/courier-branches', requireAuth(['admin']), async (req, res) => {
  const parsed = courierBranchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', issues: parsed.error.issues });
  const { id, courier_id, name, district, full_address, latitude, longitude, pincode } = parsed.data;
  const phone = parsed.data.phone?.trim() || null;
  const opening_hours = parsed.data.opening_hours?.trim() || null;

  const { rows } = id
    ? await query<{ id: string }>(
        `UPDATE courier_branches
            SET courier_id = $1, name = $2, district = $3, full_address = $4,
                latitude = $5, longitude = $6, pincode = $7, phone = $8, opening_hours = $9
          WHERE id = $10
          RETURNING id`,
        [courier_id, name, district, full_address, latitude, longitude, pincode, phone, opening_hours, id],
      )
    : await query<{ id: string }>(
        `INSERT INTO courier_branches
           (courier_id, name, district, full_address, latitude, longitude, pincode, phone, opening_hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [courier_id, name, district, full_address, latitude, longitude, pincode, phone, opening_hours],
      );

  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ id: rows[0].id });
});

router.delete('/courier-branches/:id', requireAuth(['admin']), async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM courier_branches WHERE id = $1`,
    [req.params.id],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.get('/flags', requireAuth(['admin']), async (_req, res) => {
  res.json(await getAllFlags());
});

router.put('/flags/:key', requireAuth(['admin']), async (req, res) => {
  const schema = z.object({ value: z.any() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await setFlag(req.params.key, parsed.data.value);
  res.json({ ok: true });
});

// Device-token + push-preference routes for the admin mobile app.
//
// POST/DELETE follow the agent_devices pattern: upsert on (token), best-effort
// delete on logout. push_enabled defaults TRUE so a fresh install opts in;
// the toggle in the admin app's settings flips this flag for the current
// device only (not all of the admin's devices) so admins can silence one
// phone without losing alerts on a tablet.
router.post('/device-token', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = z.object({
    token: z.string().min(20),
    platform: z.enum(['android', 'ios']),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await query(
    `INSERT INTO admin_devices (admin_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET admin_id = EXCLUDED.admin_id,
                                          platform = EXCLUDED.platform,
                                          updated_at = NOW()`,
    [adminId, parsed.data.token, parsed.data.platform],
  );
  res.json({ ok: true });
});

router.delete('/device-token', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = z.object({ token: z.string().min(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await query(`DELETE FROM admin_devices WHERE token = $1 AND admin_id = $2`,
    [parsed.data.token, adminId]);
  res.json({ ok: true });
});

router.get('/device-token/preferences', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const token = req.query.token;
  if (typeof token !== 'string' || token.length < 20) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const { rows } = await query<{ push_enabled: boolean }>(
    `SELECT push_enabled FROM admin_devices WHERE token = $1 AND admin_id = $2`,
    [token, adminId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ push_enabled: rows[0].push_enabled });
});

router.patch('/device-token/preferences', requireAuth(['admin']), async (req, res) => {
  const adminId = (req.principal as any).adminId;
  const parsed = z.object({
    token: z.string().min(20),
    push_enabled: z.boolean(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { rowCount } = await query(
    `UPDATE admin_devices SET push_enabled = $1, updated_at = NOW()
       WHERE token = $2 AND admin_id = $3`,
    [parsed.data.push_enabled, parsed.data.token, adminId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, push_enabled: parsed.data.push_enabled });
});

export default router;
