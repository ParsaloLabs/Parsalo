import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db';
import { sendOtpSms } from '../sms';
import { signAdminToken, signAgentToken, signUserToken } from '../auth';
import { env } from '../env';
import { getCustomerAuthApp } from '../firebase';

const router = Router();

const phoneSchema = z.string().regex(/^\+?\d{10,15}$/, 'Invalid phone');

const sendOtpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 3,
  message: { error: 'rate_limited', message: 'Too many OTP requests. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/send-otp', sendOtpLimiter, async (req, res) => {
  const parsed = z.object({ phone: phoneSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_phone' });
  const phone = parsed.data.phone;

  const code = env.OTP_DEV_MODE ? '123456' : String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await query(
    `INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)`,
    [phone, code, expiresAt],
  );
  await sendOtpSms(phone, code);

  return res.json({ ok: true, dev_otp: env.OTP_DEV_MODE ? code : undefined });
});

const firebaseLoginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  message: { error: 'rate_limited' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/firebase-login', firebaseLoginLimiter, async (req, res) => {
  const parsed = z.object({ id_token: z.string().min(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const app = getCustomerAuthApp();
  if (!app) return res.status(500).json({ error: 'firebase_not_configured' });

  let decoded;
  try {
    decoded = await app.auth().verifyIdToken(parsed.data.id_token);
  } catch {
    return res.status(401).json({ error: 'invalid_id_token' });
  }

  const phone = decoded.phone_number;
  if (!phone) return res.status(400).json({ error: 'no_phone_in_token' });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (phone, is_verified) VALUES ($1, TRUE)
       ON CONFLICT (phone) DO UPDATE SET is_verified = TRUE
       RETURNING id`,
    [phone],
  );
  const userId = rows[0].id;
  return res.json({ token: signUserToken(userId), user_id: userId });
});

router.post('/verify-otp', async (req, res) => {
  const parsed = z.object({ phone: phoneSchema, otp: z.string().length(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { phone, otp } = parsed.data;

  const { rows } = await query<{ id: string }>(
    `SELECT id FROM otp_codes
       WHERE phone = $1 AND code = $2 AND consumed = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
    [phone, otp],
  );
  if (rows.length === 0) return res.status(401).json({ error: 'otp_invalid_or_expired' });

  await query(`UPDATE otp_codes SET consumed = TRUE WHERE id = $1`, [rows[0].id]);

  // Upsert user
  const { rows: userRows } = await query<{ id: string }>(
    `INSERT INTO users (phone, is_verified) VALUES ($1, TRUE)
       ON CONFLICT (phone) DO UPDATE SET is_verified = TRUE
       RETURNING id`,
    [phone],
  );
  const userId = userRows[0].id;
  return res.json({ token: signUserToken(userId), user_id: userId });
});

router.post('/agent/register', async (req, res) => {
  const schema = z.object({
    phone: phoneSchema,
    full_name: z.string().trim().min(2),
    email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
    password: z.string().min(6),
    vehicle_type: z.enum(['bike', 'scooter']),
    vehicle_number: z.string().trim().min(4),
    dl_number: z.string().trim().min(4),
    city: z.string().trim().min(2),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const a = parsed.data;

  const dup = await query<{ id: string }>(`SELECT id FROM agents WHERE phone = $1`, [a.phone]);
  if (dup.rows.length > 0) return res.status(409).json({ error: 'phone_in_use' });

  const hash = await bcrypt.hash(a.password, 10);
  await query(
    `INSERT INTO agents (phone, full_name, email, password_hash, vehicle_type, vehicle_number, dl_number, city, status, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', FALSE)`,
    [a.phone, a.full_name, a.email ?? null, hash, a.vehicle_type, a.vehicle_number, a.dl_number, a.city],
  );
  return res.status(201).json({ ok: true, status: 'pending' });
});

router.post('/agent/login', async (req, res) => {
  const parsed = z.object({ phone: phoneSchema, password: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { phone, password } = parsed.data;

  const { rows } = await query<{ id: string; password_hash: string; is_active: boolean; status: string }>(
    `SELECT id, password_hash, is_active, status FROM agents WHERE phone = $1`,
    [phone],
  );
  if (rows.length === 0) return res.status(401).json({ error: 'invalid_credentials' });
  const agent = rows[0];

  const ok = await bcrypt.compare(password, agent.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  if (agent.status === 'pending') return res.status(403).json({ error: 'agent_pending_approval' });
  if (agent.status === 'rejected') return res.status(403).json({ error: 'agent_rejected' });
  if (!agent.is_active) return res.status(403).json({ error: 'agent_suspended' });

  return res.json({ token: signAgentToken(agent.id), agent_id: agent.id });
});

router.post('/admin/login', async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const { email, password } = parsed.data;

  const { rows } = await query<{ id: string; password_hash: string; role: string }>(
    `SELECT id, password_hash, role FROM admins WHERE email = $1`,
    [email],
  );
  if (rows.length === 0) return res.status(401).json({ error: 'invalid_credentials' });
  const admin = rows[0];
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  return res.json({ token: signAdminToken(admin.id, admin.role), admin_id: admin.id, role: admin.role });
});

export default router;
