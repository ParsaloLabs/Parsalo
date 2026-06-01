'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

type DispatchConfig = {
  initial_radius_m: number;
  offer_ttl_seconds: number;
  updated_at: string;
};

const OVERRIDE_CEILING_FLAG = 'max_concurrent_jobs_override_ceiling';

export default function SettingsPage() {
  const [cfg, setCfg] = useState<DispatchConfig | null>(null);
  const [radiusKm, setRadiusKm] = useState('5');
  const [ttl, setTtl] = useState('30');
  const [ceiling, setCeiling] = useState('5');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [data, flags] = await Promise.all([
      api<DispatchConfig>('/admin/dispatch-config'),
      api<Record<string, unknown>>('/admin/flags'),
    ]);
    setCfg(data);
    setRadiusKm((data.initial_radius_m / 1000).toString());
    setTtl(data.offer_ttl_seconds.toString());
    const raw = flags[OVERRIDE_CEILING_FLAG];
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) setCeiling(String(n));
  };

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const radiusM = Math.round(parseFloat(radiusKm) * 1000);
      const ttlSeconds = parseInt(ttl, 10);
      const ceilingN = parseInt(ceiling, 10);
      if (!Number.isFinite(ceilingN) || ceilingN < 2 || ceilingN > 20) {
        throw new Error('Ceiling must be between 2 and 20');
      }
      const [data] = await Promise.all([
        api<DispatchConfig>('/admin/dispatch-config', {
          method: 'POST',
          body: { initial_radius_m: radiusM, offer_ttl_seconds: ttlSeconds },
        }),
        api(`/admin/flags/${OVERRIDE_CEILING_FLAG}`, {
          method: 'PUT',
          body: { value: ceilingN },
        }),
      ]);
      setCfg(data);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-2">Settings</h1>
        <p className="text-sm text-slate-500">{error ?? 'Loading…'}</p>
      </div>
    );
  }

  const radiusM = Math.round(parseFloat(radiusKm || '0') * 1000);
  const ladder = [radiusM, radiusM * 2, radiusM * 3]
    .map((m) => `${(m / 1000).toFixed(1)} km`)
    .concat(['all online']);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-2">Settings</h1>
      <p className="text-sm text-slate-500 mb-6">
        Tune dispatch behaviour for the current environment. Changes apply within ~10 seconds.
      </p>

      <form onSubmit={save} className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide mb-4">
          Dispatch
        </h2>

        <div className="grid gap-5">
          <Field
            label="Initial search radius (km)"
            help="The first ring the dispatcher searches for nearby agents. Escalates to 2× and 3× this value, then falls back to every online agent."
          >
            <input
              type="number" step="0.1" min="0.1" max="200" required
              value={radiusKm} onChange={(e) => setRadiusKm(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-32"
            />
            <div className="text-xs text-slate-500 mt-2">
              Ladder: <span className="font-mono">{ladder.join(' → ')}</span>
            </div>
          </Field>

          <Field
            label="Offer TTL (seconds)"
            help="How long each agent has to accept an incoming offer before it expires and the next agent is tried."
          >
            <input
              type="number" step="1" min="5" max="600" required
              value={ttl} onChange={(e) => setTtl(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-32"
            />
          </Field>

          <Field
            label="Max orders when override is on"
            help="Default cap is 2 active orders per agent. When an agent flips the 'Accept more orders' switch in their app, this is the hard ceiling they can be assigned up to. Auto-resets to OFF once they drop below 2."
          >
            <input
              type="number" step="1" min="2" max="20" required
              value={ceiling} onChange={(e) => setCeiling(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-32"
            />
          </Field>
        </div>

        <div className="flex items-center gap-4 mt-6">
          <button
            type="submit" disabled={saving}
            className="bg-brand text-white text-sm font-semibold px-4 py-2 rounded-md hover:opacity-90 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {savedAt && !saving && (
            <span className="text-xs text-green-700">Saved at {savedAt}</span>
          )}
          {error && <span className="text-xs text-red-700">{error}</span>}
        </div>

        <div className="text-xs text-slate-400 mt-6">
          Last updated {new Date(cfg.updated_at).toLocaleString()}
        </div>
      </form>
    </div>
  );
}

function Field({
  label, help, children,
}: { label: string; help: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-800 mb-1">{label}</label>
      <p className="text-xs text-slate-500 mb-2">{help}</p>
      {children}
    </div>
  );
}
