import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth } from '../auth';
import { priceReceiveOrder, priceSendOrder } from '../pricing';
import { generateOrderCode } from '../orderCode';
import { notifyOrderEvent } from '../notifications';
import { buildAuthorizationPdf } from '../pdf';
import { isPinServiceable } from '../serviceArea';
import { resetExtraOrdersIfBelowCap } from './agent';

const router = Router();

const sendSchema = z.object({
  order_type: z.literal('send'),
  parcel_type: z.string().min(1),
  parcel_weight_kg: z.number().min(0.1).max(50),
  parcel_description: z.string().optional().nullable(),
  declared_value: z.number().int().nonnegative().optional().nullable(),
  pickup_address_id: z.string().uuid(),
  recipient_name: z.string().min(1),
  recipient_phone: z.string().min(10),
  delivery_address: z.string().min(5),
  delivery_lat: z.number().optional().nullable(),
  delivery_lng: z.number().optional().nullable(),
  selected_courier_id: z.string().uuid(),
  courier_charge_paise: z.number().int().nonnegative(),
  scheduled_pickup_at: z.string().datetime().optional().nullable(),
});

const receiveSchema = z.object({
  order_type: z.literal('receive'),
  source_courier_id: z.string().uuid(),
  source_tracking_id: z.string().min(3),
  source_branch_id: z.string().uuid().optional().nullable(),
  delivery_address_id: z.string().uuid(),
  same_day: z.boolean().optional().nullable(),
  user_id_proof_url: z.string().url().optional().nullable(),
  user_signature_url: z.string().url().optional().nullable(),
  scheduled_pickup_at: z.string().datetime().optional().nullable(),
});

const orderSchema = z.union([sendSchema, receiveSchema]);

function generateDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

router.post('/', requireAuth(['user']), async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  const userId = (req.principal as any).userId;
  const code = await generateOrderCode();
  const otp = generateDeliveryOtp();

  if (parsed.data.order_type === 'send') {
    const d = parsed.data;
    const price = priceSendOrder({ courier_charge_paise: d.courier_charge_paise });

    // Pin the nearest branch of the selected courier to the pickup location.
    // Agent's map destination resolves to this branch — the recipient address
    // is only read out to the courier counter for the shipping label.
    const { rows: pickupRows } = await query<{ latitude: string | null; longitude: string | null; district: string | null }>(
      `SELECT latitude, longitude, district FROM addresses WHERE id = $1 AND user_id = $2`,
      [d.pickup_address_id, userId],
    );
    if (pickupRows.length === 0) {
      return res.status(400).json({ error: 'pickup_address_not_found' });
    }
    const pLat = pickupRows[0].latitude !== null ? Number(pickupRows[0].latitude) : null;
    const pLng = pickupRows[0].longitude !== null ? Number(pickupRows[0].longitude) : null;
    const pDistrict = pickupRows[0].district;

    // Service-area gate: pin must be in a serviceable district (always), and
    // — when the radius flag is on — also within SERVICE_RADIUS_M of an office.
    // No coords ⇒ can't verify ⇒ force the customer back into the map picker.
    if (pLat === null || pLng === null) {
      return res.status(409).json({ error: 'pickup_address_missing_coords' });
    }
    if (!(await isPinServiceable(pLat, pLng, pDistrict))) {
      return res.status(409).json({ error: 'pickup_out_of_service_area' });
    }

    const { rows: branchRows } = await query<{ id: string }>(
      pLat !== null && pLng !== null
        ? `SELECT id FROM courier_branches
            WHERE courier_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL
            ORDER BY POW(latitude - $2, 2) + POW(longitude - $3, 2) ASC
            LIMIT 1`
        : `SELECT id FROM courier_branches WHERE courier_id = $1 LIMIT 1`,
      pLat !== null && pLng !== null
        ? [d.selected_courier_id, pLat, pLng]
        : [d.selected_courier_id],
    );
    if (branchRows.length === 0) {
      return res.status(400).json({ error: 'no_courier_branches_available' });
    }
    const selectedBranchId = branchRows[0].id;

    const { rows } = await query(
      `INSERT INTO orders (
         order_code, user_id, order_type, parcel_type, parcel_weight_kg, parcel_description,
         declared_value, pickup_address_id, recipient_name, recipient_phone, delivery_address,
         delivery_lat, delivery_lng,
         selected_courier_id, selected_branch_id, scheduled_pickup_at,
         courier_charge, service_fee, gst_amount, total_amount, delivery_otp
       ) VALUES ($1,$2,'send',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        code, userId, d.parcel_type, d.parcel_weight_kg, d.parcel_description ?? null,
        d.declared_value ?? null, d.pickup_address_id, d.recipient_name, d.recipient_phone,
        d.delivery_address, d.delivery_lat ?? null, d.delivery_lng ?? null,
        d.selected_courier_id, selectedBranchId, d.scheduled_pickup_at ?? null,
        price.courier_charge, price.service_fee, price.gst_amount, price.total, otp,
      ],
    );
    await query(
      `INSERT INTO order_status_history (order_id, status, changed_by_type, changed_by_id) VALUES ($1, 'pending', 'user', $2)`,
      [rows[0].id, userId],
    );
    return res.status(201).json(rows[0]);
  }

  const d = parsed.data;

  // Service-area gate: for receive orders, the agent's last hop is the
  // customer's delivery address — that's what must sit inside an active zone.
  const { rows: deliveryRows } = await query<{ latitude: string | null; longitude: string | null; district: string | null }>(
    `SELECT latitude, longitude, district FROM addresses WHERE id = $1 AND user_id = $2`,
    [d.delivery_address_id, userId],
  );
  if (deliveryRows.length === 0) {
    return res.status(400).json({ error: 'delivery_address_not_found' });
  }
  const dLat = deliveryRows[0].latitude !== null ? Number(deliveryRows[0].latitude) : null;
  const dLng = deliveryRows[0].longitude !== null ? Number(deliveryRows[0].longitude) : null;
  const dDistrict = deliveryRows[0].district;
  if (dLat === null || dLng === null) {
    return res.status(409).json({ error: 'pickup_address_missing_coords' });
  }
  if (!(await isPinServiceable(dLat, dLng, dDistrict))) {
    return res.status(409).json({ error: 'pickup_out_of_service_area' });
  }

  const price = priceReceiveOrder({ delivery_fee_paise: d.same_day ? 3000 : 0 });
  const { rows } = await query(
    `INSERT INTO orders (
       order_code, user_id, order_type, source_courier_id, source_tracking_id, source_branch_id,
       delivery_address_id, user_id_proof_url, user_signature_url, scheduled_pickup_at,
       courier_charge, service_fee, gst_amount, total_amount, delivery_otp, payment_status
     ) VALUES ($1,$2,'receive',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
     RETURNING *`,
    [
      code, userId, d.source_courier_id, d.source_tracking_id, d.source_branch_id ?? null,
      d.delivery_address_id, d.user_id_proof_url ?? null, d.user_signature_url ?? null,
      d.scheduled_pickup_at ?? null,
      price.courier_charge, price.service_fee, price.gst_amount, price.total, otp,
    ],
  );
  await query(
    `INSERT INTO order_status_history (order_id, status, changed_by_type, changed_by_id) VALUES ($1, 'pending', 'user', $2)`,
    [rows[0].id, userId],
  );
  return res.status(201).json(rows[0]);
});

router.get('/', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);
  const filter = String(req.query.filter ?? 'all'); // 'active' | 'completed' | 'all'

  const where: string[] = ['user_id = $1'];
  const params: any[] = [userId];
  if (filter === 'active') {
    where.push(`status NOT IN ('delivered','cancelled','failed')`);
  } else if (filter === 'completed') {
    where.push(`status IN ('delivered','cancelled','failed')`);
  }

  const { rows } = await query(
    `SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  res.json(rows);
});

router.get('/:id', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const { rows } = await query(`SELECT * FROM orders WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const { rows: history } = await query(
    `SELECT status, notes, changed_by_type, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at ASC`,
    [req.params.id],
  );

  let agent: any = null;
  if (rows[0].agent_id) {
    const { rows: ar } = await query<{ full_name: string; phone: string; current_lat: any; current_lng: any }>(
      `SELECT full_name, phone, current_lat, current_lng FROM agents WHERE id = $1`,
      [rows[0].agent_id],
    );
    if (ar[0]) {
      agent = {
        name: ar[0].full_name,
        phone: ar[0].phone,
        lat: ar[0].current_lat !== null ? Number(ar[0].current_lat) : null,
        lng: ar[0].current_lng !== null ? Number(ar[0].current_lng) : null,
      };
    }
  }

  res.json({ ...rows[0], history, agent });
});

router.get('/:id/authorization.pdf', requireAuth(['user', 'agent', 'admin']), async (req, res) => {
  const principal = req.principal!;
  const { rows } = await query<any>(
    `SELECT o.id, o.order_code, o.order_type, o.user_id, o.agent_id, o.created_at,
            o.source_tracking_id, o.user_signature_url, o.user_id_proof_url,
            u.full_name AS user_full_name, u.phone AS user_phone,
            c.name AS source_courier_name,
            cb.name AS source_branch_name,
            addr.full_address AS delivery_address_text,
            a.full_name AS agent_full_name, a.phone AS agent_phone,
            a.vehicle_type AS agent_vehicle_type, a.vehicle_number AS agent_vehicle_number
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN couriers c ON c.id = o.source_courier_id
       LEFT JOIN courier_branches cb ON cb.id = o.source_branch_id
       LEFT JOIN addresses addr ON addr.id = o.delivery_address_id
       LEFT JOIN agents a ON a.id = o.agent_id
      WHERE o.id = $1`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const o = rows[0];

  if (o.order_type !== 'receive') {
    return res.status(400).json({ error: 'auth_doc_only_for_receive_orders' });
  }
  if (principal.kind === 'user' && o.user_id !== (principal as any).userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (principal.kind === 'agent' && o.agent_id !== (principal as any).agentId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const pdf = await buildAuthorizationPdf({
    order: {
      id: o.id,
      order_code: o.order_code,
      source_tracking_id: o.source_tracking_id,
      user_signature_url: o.user_signature_url,
      user_id_proof_url: o.user_id_proof_url,
      created_at: o.created_at,
    },
    user: { full_name: o.user_full_name, phone: o.user_phone },
    deliveryAddress: o.delivery_address_text,
    sourceCourierName: o.source_courier_name,
    sourceBranchName: o.source_branch_name,
    agent: o.agent_full_name ? {
      full_name: o.agent_full_name,
      phone: o.agent_phone,
      vehicle_type: o.agent_vehicle_type,
      vehicle_number: o.agent_vehicle_number,
    } : null,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="authorization-${o.order_code}.pdf"`);
  res.send(pdf);
});

router.post('/:id/retry', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const parsed = z.object({ when: z.enum(['today', 'tomorrow']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const retryAtSql = parsed.data.when === 'today'
    ? 'NULL'
    : `(DATE_TRUNC('day', (NOW() AT TIME ZONE 'Asia/Kolkata')) + INTERVAL '1 day 9 hours') AT TIME ZONE 'Asia/Kolkata'`;
  const { rows } = await query<{ id: string; retry_at: string | null }>(
    `UPDATE orders
        SET status = 'pending', agent_id = NULL,
            retry_at = ${retryAtSql},
            failure_reason = NULL,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'failed'
      RETURNING id, retry_at`,
    [req.params.id, userId],
  );
  if (rows.length === 0) return res.status(409).json({ error: 'not_failed' });
  await query(
    `INSERT INTO order_status_history (order_id, status, notes, changed_by_type, changed_by_id)
       VALUES ($1, 'pending', $2, 'user', $3)`,
    [req.params.id, `customer chose retry ${parsed.data.when}`, userId],
  );
  res.json({ ok: true, retry_at: rows[0].retry_at });
});

router.post('/:id/request-refund', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const { rows } = await query(
    `UPDATE orders SET payment_status = 'refund_requested', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'failed' AND payment_status = 'paid'
      RETURNING id`,
    [req.params.id, userId],
  );
  if (rows.length === 0) return res.status(409).json({ error: 'cannot_request_refund' });
  await query(
    `INSERT INTO order_status_history (order_id, status, notes, changed_by_type, changed_by_id)
       VALUES ($1, 'failed', 'customer requested refund', 'user', $2)`,
    [req.params.id, userId],
  );
  res.json({ ok: true });
});

router.post('/:id/cancel', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const reason = String(req.body?.reason ?? '');
  const { rows } = await query<{ status: string }>(
    `SELECT status FROM orders WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  if (['delivered', 'cancelled', 'failed'].includes(rows[0].status)) {
    return res.status(400).json({ error: 'cannot_cancel' });
  }
  const { rows: agentRows } = await query<{ agent_id: string | null }>(
    `SELECT agent_id FROM orders WHERE id = $1`,
    [req.params.id],
  );
  await query(
    `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [req.params.id],
  );
  await query(
    `INSERT INTO order_status_history (order_id, status, notes, changed_by_type, changed_by_id) VALUES ($1, 'cancelled', $2, 'user', $3)`,
    [req.params.id, reason, userId],
  );
  if (agentRows[0]?.agent_id) {
    await resetExtraOrdersIfBelowCap(agentRows[0].agent_id);
  }
  notifyOrderEvent(req.params.id, 'cancelled');
  res.json({ ok: true });
});

export default router;
