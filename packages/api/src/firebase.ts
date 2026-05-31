import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { env } from './env';

// Two firebase-admin apps. The default app (FIREBASE_PROJECT_ID) is used for
// agent FCM push (push.ts). A second named app (CUSTOMER_FIREBASE_PROJECT_ID)
// verifies customer phone-OTP ID tokens (routes/auth.ts firebase-login).
// They're split because the FCM project (pkb-parsalo) was upgraded to Identity
// Platform and that broke real-number phone sign-in, so customer OTP lives in
// a separate plain-Firebase-Auth project.

let initAttempted = false;
let app: admin.app.App | null = null;
let customerInitAttempted = false;
let customerApp: admin.app.App | null = null;

export function getFirebaseApp(): admin.app.App | null {
  if (initAttempted) return app;
  initAttempted = true;

  let credentialJson: string | null = null;
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credentialJson = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  } else if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      credentialJson = readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf-8');
    } catch (e) {
      console.warn('[firebase] failed to read service account file', e);
      return null;
    }
  }

  try {
    if (credentialJson) {
      const parsed = JSON.parse(credentialJson);
      app = admin.initializeApp({ credential: admin.credential.cert(parsed) });
      console.log('[firebase] admin SDK initialised (service account key)');
    } else if (env.FIREBASE_PROJECT_ID) {
      // ADC path — used when key-file creation is blocked by org policy.
      // Picks up credentials from `gcloud auth application-default login`.
      app = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: env.FIREBASE_PROJECT_ID,
      });
      console.log(`[firebase] admin SDK initialised (ADC, project=${env.FIREBASE_PROJECT_ID})`);
    } else {
      console.log('[firebase:dev] no credentials — FCM logs to stdout, auth verify will fail');
      return null;
    }
    return app;
  } catch (e) {
    console.warn('[firebase] failed to init admin SDK', e);
    return null;
  }
}

export function getCustomerAuthApp(): admin.app.App | null {
  if (customerInitAttempted) return customerApp;
  customerInitAttempted = true;

  if (!env.CUSTOMER_FIREBASE_PROJECT_ID) {
    console.log('[firebase:dev] CUSTOMER_FIREBASE_PROJECT_ID not set — customer OTP verify will fail');
    return null;
  }

  let credentialJson: string | null = null;
  if (env.CUSTOMER_FIREBASE_SERVICE_ACCOUNT_JSON) {
    credentialJson = env.CUSTOMER_FIREBASE_SERVICE_ACCOUNT_JSON;
  } else if (env.CUSTOMER_FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      credentialJson = readFileSync(env.CUSTOMER_FIREBASE_SERVICE_ACCOUNT_PATH, 'utf-8');
    } catch (e) {
      console.warn('[firebase] failed to read customer service account file', e);
      return null;
    }
  }

  try {
    if (credentialJson) {
      const parsed = JSON.parse(credentialJson);
      customerApp = admin.initializeApp(
        { credential: admin.credential.cert(parsed) },
        'customer-auth',
      );
      console.log(`[firebase] customer auth app initialised (service account key, project=${env.CUSTOMER_FIREBASE_PROJECT_ID})`);
    } else {
      customerApp = admin.initializeApp(
        {
          credential: admin.credential.applicationDefault(),
          projectId: env.CUSTOMER_FIREBASE_PROJECT_ID,
        },
        'customer-auth',
      );
      console.log(`[firebase] customer auth app initialised (ADC, project=${env.CUSTOMER_FIREBASE_PROJECT_ID})`);
    }
    return customerApp;
  } catch (e) {
    console.warn('[firebase] failed to init customer auth app', e);
    return null;
  }
}
