import { env } from './env';
import { query } from './db';
import { sendPushToAdmins, sendPushToAgent, sendPushToUser } from './push';
import { broadcastToOrder } from './io';

const DEV = !env.MSG91_AUTH_KEY;

// Generic transactional SMS via MSG91 Flow API.
// In dev mode (no auth key) we log to stdout so the full flow is visible without a paid integration.
export async function sendSms(phone: string, message: string) {
  if (DEV) {
    console.log(`[sms:dev] → ${phone}\n  ${message}`);
    return;
  }
  // MSG91 Flow API requires a DLT-registered template. The message is templated server-side
  // by Flow ID + variable bindings; we send the body verbatim as the single VAR1 substitution.
  // Operator should configure a generic "{{var}}" template and put its flow_id in MSG91_TXN_TEMPLATE_ID.
  const body = {
    flow_id: env.MSG91_TXN_TEMPLATE_ID,
    sender: env.MSG91_SENDER_ID,
    short_url: '0',
    mobiles: phone.replace(/^\+?/, ''),
    VAR1: message,
  };
  try {
    await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn('[sms] send failed', e);
  }
}

type OrderEvent =
  | 'paid'
  | 'agent_assigned'
  | 'agent_en_route_pickup'
  | 'parcel_collected'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'failed';

type OrderRow = {
  id: string; order_code: string; order_type: 'send' | 'receive';
  total_amount: number; delivery_otp: string;
  user_id: string; user_phone: string;
  agent_phone?: string | null; agent_name?: string | null;
};

async function loadOrder(orderId: string): Promise<OrderRow | null> {
  const { rows } = await query<OrderRow>(
    `SELECT o.id, o.order_code, o.order_type, o.total_amount, o.delivery_otp,
            o.user_id,
            u.phone AS user_phone,
            a.phone AS agent_phone, a.full_name AS agent_name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       LEFT JOIN agents a ON a.id = o.agent_id
      WHERE o.id = $1`,
    [orderId],
  );
  return rows[0] ?? null;
}

const RECEIVE = 'receive';

function customerMessage(o: OrderRow, event: OrderEvent): string | null {
  const code = o.order_code;
  switch (event) {
    case 'paid':
      return `Parsalo: ${code} booked. We're finding an agent. Track at parsalo.in`;
    case 'agent_assigned':
      return `Parsalo: ${o.agent_name ?? 'Agent'} (${o.agent_phone ?? '—'}) is assigned to ${code}. ` +
        (o.order_type === RECEIVE
          ? `They'll pick up your parcel from the courier office.`
          : `Keep your parcel + OTP ${o.delivery_otp} ready for pickup.`);
    case 'agent_en_route_pickup':
      return `Parsalo: Agent on the way for ${code}. ` +
        (o.order_type === RECEIVE ? `Heading to the courier office.` : `Share OTP ${o.delivery_otp} at pickup.`);
    case 'parcel_collected':
      return `Parsalo: Parcel collected for ${code}. ` +
        (o.order_type === RECEIVE ? `Heading to your address now.` : `It's on the way to the courier office.`);
    case 'out_for_delivery':
      return o.order_type === RECEIVE
        ? `Parsalo: Agent is on the way to deliver ${code}. Share OTP ${o.delivery_otp} at handover.`
        : `Parsalo: ${code} is on the way to the courier office.`;
    case 'delivered':
      return o.order_type === RECEIVE
        ? `Parsalo: ${code} delivered. Hope to serve you again!`
        : `Parsalo: ${code} dropped at the courier office. Tracking ID will follow on courier SMS.`;
    case 'cancelled':
      return `Parsalo: ${code} was cancelled. Refund (if applicable) is processing.`;
    case 'failed':
      return `Parsalo: ${code} could not be completed. Open the app to retry today, retry tomorrow, or request a refund.`;
    default:
      return null;
  }
}

function agentMessage(o: OrderRow, event: OrderEvent): string | null {
  if (event === 'agent_assigned') {
    return `Parsalo: You're assigned to ${o.order_code} (${o.order_type}). Open the agent app for details.`;
  }
  return null;
}

// Short customer-app push body — SMS copy above is long-form for offline users
// without the app. The phone-popup version is tighter to fit the lockscreen.
function customerPush(o: OrderRow, event: OrderEvent): { title: string; body: string } | null {
  switch (event) {
    case 'paid':
      return { title: `Order ${o.order_code} booked`, body: `We're finding an agent for you.` };
    case 'agent_assigned':
      return {
        title: `Agent assigned · ${o.order_code}`,
        body: `${o.agent_name ?? 'Your agent'} is on it. Tap to track.`,
      };
    case 'agent_en_route_pickup':
      return { title: `Agent on the way · ${o.order_code}`, body: `Heading to ${o.order_type === RECEIVE ? 'the courier office' : 'your address'}.` };
    case 'parcel_collected':
      return {
        title: `Parcel collected · ${o.order_code}`,
        body: o.order_type === RECEIVE ? `Coming to your address now.` : `On the way to the courier.`,
      };
    case 'out_for_delivery':
      return { title: `Out for delivery · ${o.order_code}`, body: o.order_type === RECEIVE ? `Share OTP ${o.delivery_otp} at handover.` : `Almost at the courier office.` };
    case 'delivered':
      return { title: `Delivered ✓ · ${o.order_code}`, body: o.order_type === RECEIVE ? `Hope to serve you again!` : `Tracking ID will follow on courier SMS.` };
    case 'cancelled':
      return { title: `Cancelled · ${o.order_code}`, body: `Refund (if applicable) is processing.` };
    case 'failed':
      return { title: `Couldn't complete ${o.order_code}`, body: `Open the app to retry or request a refund.` };
    default:
      return null;
  }
}

// Admin push — only for events that warrant operator attention. We skip the
// happy-path middle states (en_route, collected, out_for_delivery) so admins
// aren't pinged 6 times per order.
function adminPush(o: OrderRow, event: OrderEvent): { title: string; body: string } | null {
  switch (event) {
    case 'paid':
      return { title: `New order · ${o.order_code}`, body: `${o.order_type === 'send' ? 'Send' : 'Receive'} · ₹${Math.round(o.total_amount / 100)}` };
    case 'cancelled':
      return { title: `Cancelled · ${o.order_code}`, body: `Order cancelled.` };
    case 'failed':
      return { title: `Failed · ${o.order_code}`, body: `Order could not be completed.` };
    default:
      return null;
  }
}

export async function notifyOrderEvent(orderId: string, event: OrderEvent) {
  try {
    // Broadcast status change immediately to all connected clients tracking this order
    broadcastToOrder(orderId, 'status_changed', { status: event });

    const o = await loadOrder(orderId);
    if (!o) return;
    const cust = customerMessage(o, event);
    if (cust) await sendSms(o.user_phone, cust);
    const agt = agentMessage(o, event);
    if (agt && o.agent_phone) await sendSms(o.agent_phone, agt);

    // Push the assigned agent's device(s) when admin assigns directly. Self-
    // accept doesn't need a push — the agent is already in-app and we want
    // to avoid notifying their own action back at them.
    if (event === 'agent_assigned') {
      const { rows } = await query<{ agent_id: string | null }>(
        `SELECT agent_id FROM orders WHERE id = $1`,
        [orderId],
      );
      const agentId = rows[0]?.agent_id;
      if (agentId) {
        await sendPushToAgent(agentId, {
          title: `New job — ${o.order_code}`,
          body: `${o.order_type === 'send' ? 'Dispatch send' : 'Partner collect'} · ₹${Math.round(o.total_amount / 100)}`,
          data: { orderId, kind: 'assigned' },
        });
      }
    }

    // Push the customer's device(s) on every status change so the lockscreen
    // updates without them having to open the app.
    const cp = customerPush(o, event);
    if (cp) {
      await sendPushToUser(o.user_id, {
        title: cp.title,
        body: cp.body,
        data: { orderId, kind: 'order_event', event },
      });
    }

    // Push admins on operator-relevant events only.
    const ap = adminPush(o, event);
    if (ap) {
      await sendPushToAdmins({
        title: ap.title,
        body: ap.body,
        data: { orderId, kind: 'order_event', event },
      });
    }
  } catch (e) {
    console.warn('[notify] failed', e);
  }
}

