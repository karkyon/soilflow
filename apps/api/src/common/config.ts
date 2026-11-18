/* 設定値（環境変数）。秘密の値は Secret Manager から環境変数で渡す（13 6章） */
import { createHash } from 'node:crypto';

const env = (k: string, d = '') => process.env[k] ?? d;
const isProd = () => env('NODE_ENV') === 'production';

export const config = {
  get isProd() { return isProd(); },
  get isTest() { return env('NODE_ENV') === 'test'; },
  get port() { return Number(env('PORT', '4000')); },
  get databaseUrl() { return env('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/soilflow'); },
  get publicBaseUrl() { return env('PUBLIC_BASE_URL', `http://localhost:${env('PORT', '4000')}`).replace(/\/$/, ''); },
  get sessionSecret() {
    const s = env('SESSION_SECRET');
    if (!s && isProd()) throw new Error('SESSION_SECRET が設定されていません');
    return s || 'dev-session-secret-change-me';
  },
  get cookieSecure() { return env('COOKIE_SECURE', isProd() ? 'true' : 'false') === 'true'; },
  /** freee の鍵をローカルで暗号化する鍵（KMS を使わないとき）。32バイト */
  get tokenEncKey() { return createHash('sha256').update(env('TOKEN_ENC_KEY') || `${this.sessionSecret}:token`).digest(); },
  get adapters(): 'fake' | 'real' { return env('ADAPTERS', isProd() ? 'real' : 'fake') === 'real' ? 'real' : 'fake'; },
  get storageDir() { return env('STORAGE_DIR', '.storage'); },
  get gcsBucket() { return env('GCS_BUCKET'); },
  get kmsKeyName() { return env('KMS_KEY_NAME'); },
  get sendgridApiKey() { return env('SENDGRID_API_KEY'); },
  get sendgridWebhookPublicKey() { return env('SENDGRID_WEBHOOK_PUBLIC_KEY'); },
  get mailRedirectTo() { return env('MAIL_REDIRECT_TO'); },
  get freeeClientId() { return env('FREEE_CLIENT_ID'); },
  get freeeClientSecret() { return env('FREEE_CLIENT_SECRET'); },
  get freeeRedirectUri() { return env('FREEE_REDIRECT_URI', `${this.publicBaseUrl}/api/v1/freee/oauth/callback`); },
  get freeeAuthBase() { return env('FREEE_AUTH_BASE', 'https://accounts.secure.freee.co.jp'); },
  get freeeApiBase() { return env('FREEE_API_BASE', 'https://api.freee.co.jp'); },
  get schedulerAudience() { return env('SCHEDULER_AUDIENCE'); },
  get schedulerServiceAccount() { return env('SCHEDULER_SERVICE_ACCOUNT'); },
  /** 画面の freee 連携設定（SCR-41）の URL。OAuth の戻り先 */
  get freeeSettingsPath() { return env('FREEE_SETTINGS_PATH', '/office/freee/settings'); },
};
