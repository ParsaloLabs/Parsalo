-- Per-agent override of the global MAX_CONCURRENT_JOBS dispatch cap.
-- When TRUE the agent is eligible for new offers past the global cap, up to
-- the admin-configured ceiling (feature_flags.max_concurrent_jobs_override_ceiling).
-- Always defaults FALSE; the agent app flips it on per-shift and the server
-- auto-resets it back to FALSE when active job count drops below the global cap.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS accept_extra_orders BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO feature_flags (key, value) VALUES
  ('max_concurrent_jobs_override_ceiling', '5'::jsonb)
ON CONFLICT (key) DO NOTHING;
