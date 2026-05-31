import Pusher from 'pusher';
import { env } from './env';

let pusher: Pusher | null = null;

const isReal = (v: string) => !!v && !v.startsWith('your_');

export function initializeSocket() {
  if (
    isReal(env.PUSHER_APP_ID) &&
    isReal(env.PUSHER_KEY) &&
    isReal(env.PUSHER_SECRET) &&
    isReal(env.PUSHER_CLUSTER)
  ) {
    pusher = new Pusher({
      appId: env.PUSHER_APP_ID,
      key: env.PUSHER_KEY,
      secret: env.PUSHER_SECRET,
      cluster: env.PUSHER_CLUSTER,
      useTLS: true,
    });
    console.log('[pusher] Channels API client initialized');
  } else {
    console.warn(
      '[pusher] credentials missing or placeholder — real-time events will log to standard console'
    );
  }
}

export function broadcastToOrder(orderId: string, event: string, payload: any) {
  if (!pusher) {
    console.log(`[pusher:mock] broadcast order-${orderId} event:${event}`, payload);
    return;
  }
  pusher.trigger(`order-${orderId}`, event, payload)
    .catch((err) => {
      console.error(`[pusher:error] broadcast to order-${orderId} failed`, err);
    });
}
