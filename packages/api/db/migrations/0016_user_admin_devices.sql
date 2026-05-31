-- FCM device tokens for the customer mobile app (apps/mobile) and the admin
-- mobile app (apps/admin-mobile). Mirrors agent_devices (0006) but split per
-- principal type so the FK can point at the right table and so the admin row
-- can carry its own push_enabled toggle.
--
-- Notes:
-- - token is globally unique in each table because FCM never reissues the same
--   token to two devices; on conflict we move ownership to the new principal.
-- - admin_devices.push_enabled is the per-device on/off toggle the admin
--   controls from in-app settings. Defaults TRUE so a fresh install opts in.

CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices (user_id);

CREATE TABLE IF NOT EXISTS admin_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_devices_admin_id ON admin_devices (admin_id);
