/*
 * 初期データ（07 10章、16 移行・導入計画書）。何度流しても同じ結果になる。
 *   pnpm --filter api db:seed                 価格表・車格・品目・印・設定（spec/seed.sql）と最初の管理者
 *   SEED_ADMIN_PASSWORD=… で管理者の仮のパスワードを指定（指定しなければ作って表示する。初回ログインで変更）
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { hashPassword, temporaryPassword } from '../src/modules/auth/password';
import { API_ROOT } from '../scripts/migrate';

export async function seed(url = process.env.DATABASE_URL, log = console.log) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(readFileSync(join(API_ROOT, 'prisma', 'seed.sql'), 'utf8'));
    const login = (process.env.SEED_ADMIN_LOGIN ?? 'admin').toLowerCase();
    const exists = await db.query('SELECT 1 FROM users WHERE role = $1 LIMIT 1', ['ADMIN']);
    if (!exists.rowCount) {
      const pw = process.env.SEED_ADMIN_PASSWORD || temporaryPassword();
      await db.query(
        `INSERT INTO users (login_id, name, role, email, password_hash, mfa_enabled, must_change_password) VALUES ($1, $2, 'ADMIN', $3, $4, $5, true)`,
        [login, process.env.SEED_ADMIN_NAME ?? '管理者', process.env.SEED_ADMIN_EMAIL || null, await hashPassword(pw), !!process.env.SEED_ADMIN_EMAIL],
      );
      log(`管理者を作成しました：ログイン ID ${login}${process.env.SEED_ADMIN_PASSWORD ? '' : `／仮のパスワード ${pw}`}（初回ログインで変更してください）`);
    }
    log('初期データを入れました');
  } finally { await db.end(); }
}
if (require.main === module) seed().catch((e) => { console.error(e); process.exit(1); });
