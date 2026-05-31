import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth } from '../auth';

const router = Router();

router.get('/me', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const { rows } = await query(
    `SELECT id, phone, email, full_name, is_verified, created_at FROM users WHERE id = $1`,
    [userId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  return res.json(rows[0]);
});

router.put('/me', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const parsed = z
    .object({ email: z.string().email().optional(), full_name: z.string().min(1).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { email, full_name } = parsed.data;
  const { rows } = await query(
    `UPDATE users SET email = COALESCE($2, email), full_name = COALESCE($3, full_name)
       WHERE id = $1 RETURNING id, phone, email, full_name, is_verified`,
    [userId, email ?? null, full_name ?? null],
  );
  return res.json(rows[0]);
});

// Device-token registration for FCM pushes from the customer mobile app.
// Upsert on (token) — same pattern as agent_devices: if the device is re-used
// by a different user (rare but possible on shared phones) the row moves to
// the new owner.
router.post('/device-token', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const parsed = z.object({
    token: z.string().min(20),
    platform: z.enum(['android', 'ios']),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await query(
    `INSERT INTO user_devices (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id,
                                          platform = EXCLUDED.platform,
                                          updated_at = NOW()`,
    [userId, parsed.data.token, parsed.data.platform],
  );
  res.json({ ok: true });
});

router.delete('/device-token', requireAuth(['user']), async (req, res) => {
  const userId = (req.principal as any).userId;
  const parsed = z.object({ token: z.string().min(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  await query(`DELETE FROM user_devices WHERE token = $1 AND user_id = $2`,
    [parsed.data.token, userId]);
  res.json({ ok: true });
});

export default router;
