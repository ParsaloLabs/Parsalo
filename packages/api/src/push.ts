import admin from 'firebase-admin';
import { getCustomerAuthApp, getFirebaseApp } from './firebase';
import { query } from './db';

function getMessaging(): admin.messaging.Messaging | null {
  const app = getFirebaseApp();
  return app ? app.messaging() : null;
}

// Customer device tokens are minted by the parsalo-otp Firebase project (the
// app uses that project's google-services.json for phone-auth too) so FCM
// sends to them must authenticate via the customer-auth admin app. The agent
// + admin apps both live in parsalo-fcm and use the default app above.
function getCustomerMessaging(): admin.messaging.Messaging | null {
  const app = getCustomerAuthApp();
  return app ? app.messaging() : null;
}

export type PushPayload = {
  title: string;
  body: string;
  // Free-form key/values delivered to the client. Strings only — FCM
  // requires string values in the data block, so callers pre-stringify.
  data?: Record<string, string>;
};

async function loadTokensForAgent(agentId: string): Promise<string[]> {
  const { rows } = await query<{ token: string }>(
    `SELECT token FROM agent_devices WHERE agent_id = $1`,
    [agentId],
  );
  return rows.map((r) => r.token);
}

async function loadTokensForOnlineAgents(): Promise<string[]> {
  const { rows } = await query<{ token: string }>(
    `SELECT d.token
       FROM agent_devices d
       JOIN agents a ON a.id = d.agent_id
      WHERE a.is_online = TRUE AND a.is_active = TRUE`,
  );
  return rows.map((r) => r.token);
}

type DeviceTable = 'agent_devices' | 'user_devices' | 'admin_devices';

async function pruneInvalidTokens(table: DeviceTable, badTokens: string[]) {
  if (badTokens.length === 0) return;
  await query(`DELETE FROM ${table} WHERE token = ANY($1::text[])`, [badTokens]);
}

async function sendViaMessaging(
  fcm: admin.messaging.Messaging | null,
  table: DeviceTable,
  tokens: string[],
  payload: PushPayload,
) {
  if (tokens.length === 0) return;
  if (!fcm) {
    console.log(`[push:dev] would send to ${tokens.length} device(s) [${table}]:`, payload);
    return;
  }

  const res = await fcm.sendEachForMulticast({
    tokens,
    notification: { title: payload.title, body: payload.body },
    data: payload.data ?? {},
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  });

  const stale: string[] = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      stale.push(tokens[i]);
    } else {
      console.warn('[push] send error', code, r.error?.message);
    }
  });
  if (stale.length) await pruneInvalidTokens(table, stale);
}

async function sendToTokens(tokens: string[], payload: PushPayload) {
  await sendViaMessaging(getMessaging(), 'agent_devices', tokens, payload);
}

export async function sendPushToAgent(agentId: string, payload: PushPayload) {
  try {
    const tokens = await loadTokensForAgent(agentId);
    await sendToTokens(tokens, payload);
  } catch (e) {
    console.warn('[push] agent send failed', e);
  }
}

export async function sendPushToOnlineAgents(payload: PushPayload) {
  try {
    const tokens = await loadTokensForOnlineAgents();
    await sendToTokens(tokens, payload);
  } catch (e) {
    console.warn('[push] broadcast failed', e);
  }
}

async function loadTokensForUser(userId: string): Promise<string[]> {
  const { rows } = await query<{ token: string }>(
    `SELECT token FROM user_devices WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.token);
}

async function loadTokensForEnabledAdmins(): Promise<string[]> {
  const { rows } = await query<{ token: string }>(
    `SELECT token FROM admin_devices WHERE push_enabled = TRUE`,
  );
  return rows.map((r) => r.token);
}

export async function sendPushToUser(userId: string, payload: PushPayload) {
  try {
    const tokens = await loadTokensForUser(userId);
    await sendViaMessaging(getCustomerMessaging(), 'user_devices', tokens, payload);
  } catch (e) {
    console.warn('[push] user send failed', e);
  }
}

export async function sendPushToAdmins(payload: PushPayload) {
  try {
    const tokens = await loadTokensForEnabledAdmins();
    await sendViaMessaging(getMessaging(), 'admin_devices', tokens, payload);
  } catch (e) {
    console.warn('[push] admin broadcast failed', e);
  }
}
