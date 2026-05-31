import 'dotenv/config';

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  OTP_DEV_MODE: (process.env.OTP_DEV_MODE ?? 'true') === 'true',
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? '',
  TRUST_PROXY: (process.env.TRUST_PROXY ?? 'false') === 'true',
  MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY ?? '',
  MSG91_SENDER_ID: process.env.MSG91_SENDER_ID ?? 'PRCLPL',
  MSG91_TEMPLATE_ID: process.env.MSG91_TEMPLATE_ID ?? '',
  MSG91_TXN_TEMPLATE_ID: process.env.MSG91_TXN_TEMPLATE_ID ?? '',
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID ?? '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET ?? '',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  PUSHER_APP_ID: process.env.PUSHER_APP_ID ?? '',
  PUSHER_KEY: process.env.PUSHER_KEY ?? '',
  PUSHER_SECRET: process.env.PUSHER_SECRET ?? '',
  PUSHER_CLUSTER: process.env.PUSHER_CLUSTER ?? 'ap2',
  // Firebase Admin SDK — pick whichever is easier per environment.
  // PATH = filesystem path to service-account JSON (best for local dev,
  // never commit the file). JSON = the entire JSON inlined as one env var
  // (best for hosts like Fly/Render that prefer env-only secrets).
  FIREBASE_SERVICE_ACCOUNT_PATH: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? '',
  FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '',
  // Used by Application Default Credentials path (when neither service-account
  // env var is set). Required because the ADC file alone doesn't carry the
  // project ID, but firebase-admin needs it to send FCM.
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? '',
  // Separate Firebase project used ONLY for customer phone OTP (web + mobile).
  // Kept separate from FIREBASE_PROJECT_ID because that one is Identity-Platform-
  // upgraded and breaks real-number sign-in; the OTP project is plain Firebase Auth.
  CUSTOMER_FIREBASE_PROJECT_ID: process.env.CUSTOMER_FIREBASE_PROJECT_ID ?? '',
  // Same idea as the primary FIREBASE_SERVICE_ACCOUNT_* pair, but for the customer
  // OTP project — needed on hosts where ADC isn't set up (e.g. our oracle VPS).
  CUSTOMER_FIREBASE_SERVICE_ACCOUNT_PATH: process.env.CUSTOMER_FIREBASE_SERVICE_ACCOUNT_PATH ?? '',
  CUSTOMER_FIREBASE_SERVICE_ACCOUNT_JSON: process.env.CUSTOMER_FIREBASE_SERVICE_ACCOUNT_JSON ?? '',
};
