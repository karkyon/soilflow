/*
 * E2E 試験の DB（15 2.5）。スキーマを作り直し、初期データ（spec/seed.sql）と試験の利用者を入れる。
 *   DATABASE_URL=… tsx scripts/e2e-reset.ts
 * マスタ（請求先・客先・現場）と先月の便は e2e/global-setup.ts が API で作る。
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { API_ROOT, migrate } from './migrate';
import { hashPassword } from '../src/modules/auth/password';

export const E2E_PASSWORD = 'e2e-correct-horse-battery';

async function main() {
  const url = process.env.DATABASE_URL!;
  if (!/e2e|test/.test(url)) throw new Error(`E2E 用の DB ではありません：${url}`);
  const admin = new Client({ connectionString: url.replace(/\/[^/?]+(\?|$)/, '/postgres$1') });
  await admin.connect();
  const name = new URL(url).pathname.slice(1);
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(url, () => undefined);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(readFileSync(join(API_ROOT, 'prisma', 'seed.sql'), 'utf8'));
    await db.query(`UPDATE settings SET mail_from_address = 'seikyu@fujimoto.example', mail_from_name = '株式会社フジモト', tel = '086-000-0000', invoice_registration_no = 'T1234567890123'`);
    const hash = await hashPassword(E2E_PASSWORD);
    const users: [string, string, string, string | null][] = [
      ['admin', '管理者', 'ADMIN', 'admin@fujimoto.example'], ['office', '本社 花子', 'OFFICE', null],
      ['reception', '受付 太郎', 'RECEPTION', null], ['tablet1', 'サイン用タブレット1', 'SIGN_TERMINAL', null],
    ];
    for (const [l, n, r, e] of users) await db.query(`INSERT INTO users (login_id, name, role, email, password_hash, mfa_enabled, must_change_password) VALUES ($1,$2,$3,$4,$5,false,false)`, [l, n, r, e, hash]);
    await db.query(`UPDATE users SET paired_terminal_id = (SELECT id FROM users WHERE login_id = 'tablet1') WHERE login_id IN ('reception','office','admin')`);
  } finally { await db.end(); }
  console.log('E2E の DB を作り直しました');
}
main().catch((e) => { console.error(e); process.exit(1); });
