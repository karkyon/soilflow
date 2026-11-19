/*
 * 性能試験のデータ（15 2.6）：客先300・現場800・車番1,000・請求先50、10年分（約2,500日・1日80行・便約300件＝75万件）。
 * 速さのため SQL でまとめて入れる（計算・状態の遷移は通らない。請求書は scripts/perf.ts が締めの API で作る）。
 *   DATABASE_URL=…/soilflow_perf tsx scripts/perf-seed.ts [日数=2500]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { API_ROOT, migrate } from './migrate';
import { hashPassword } from '../src/modules/auth/password';

export const PERF_PASSWORD = 'perf-correct-horse-battery';

async function main() {
  const url = process.env.DATABASE_URL!;
  if (!/perf/.test(url)) throw new Error(`性能試験用の DB ではありません：${url}`);
  const days = Number(process.argv[2] ?? 2500);
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
  const t0 = Date.now();
  const step = async (label: string, sql: string, params: unknown[] = []) => { const s = Date.now(); const r = await db.query(sql, params); console.log(`${label}：${r.rowCount ?? ''} 件 ${((Date.now() - s) / 1000).toFixed(1)}秒`); };
  try {
    await db.query(readFileSync(join(API_ROOT, 'prisma', 'seed.sql'), 'utf8'));
    await db.query(`UPDATE settings SET mail_from_address = 'seikyu@fujimoto.example', mail_from_name = '株式会社フジモト'`);
    const hash = await hashPassword(PERF_PASSWORD);
    for (const [l, n, r] of [['admin', '管理者', 'ADMIN'], ['office', '本社', 'OFFICE'], ['reception', '受付', 'RECEPTION'], ['reception2', '受付2', 'RECEPTION'], ['tablet1', 'タブレット1', 'SIGN_TERMINAL']])
      await db.query(`INSERT INTO users (login_id, name, role, password_hash, mfa_enabled, must_change_password) VALUES ($1,$2,$3,$4,false,false)`, [l, n, r, hash]);
    await db.query(`UPDATE users SET paired_terminal_id = (SELECT id FROM users WHERE login_id = 'tablet1') WHERE role IN ('RECEPTION','OFFICE','ADMIN')`);

    await step('請求先', `INSERT INTO billing_parties (name, kana, mail_to, closing_day) SELECT '請求先' || lpad(g::text, 3, '0'), 'せいきゅうさき' || g, ARRAY['bp' || g || '@example.jp'], CASE WHEN g % 10 = 0 THEN 20 ELSE 0 END FROM generate_series(1, 50) g`);
    await step('客先', `INSERT INTO customers (name, kana, default_billing_party_id, sort_order)
      SELECT '客先' || lpad(g::text, 3, '0'), (ARRAY['あ','か','さ','た','な','は','ま','や','ら','わ'])[1 + g % 10] || 'きゃくさき' || g, (SELECT id FROM billing_parties ORDER BY name OFFSET (g % 50) LIMIT 1), g FROM generate_series(0, 299) g`);
    await db.query(`CREATE TEMP TABLE cust AS SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS n FROM customers`);
    await step('現場', `INSERT INTO sites (customer_id, name, kana) SELECT c.id, '現場' || lpad(g::text, 3, '0'), 'げんば' || g FROM generate_series(0, 799) g JOIN cust c ON c.n = g % 300`);
    await step('車番', `INSERT INTO vehicles (customer_id, vehicle_no, default_vehicle_class_id) SELECT c.id, lpad(g::text, 4, '0'), (SELECT id FROM vehicle_classes ORDER BY sort_order OFFSET (g % 5) LIMIT 1) FROM generate_series(0, 999) g JOIN cust c ON c.n = g % 300`);
    await db.query(`CREATE TEMP TABLE veh AS SELECT v.id, v.customer_id, v.default_vehicle_class_id AS vc, (SELECT s.id FROM sites s WHERE s.customer_id = v.customer_id ORDER BY s.name LIMIT 1) AS site_id, row_number() OVER (ORDER BY v.vehicle_no) - 1 AS n FROM vehicles v`);
    await db.query(`CREATE TEMP TABLE itm AS SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS n FROM items WHERE direction = 'RECEIVE' AND active`);
    const ni = (await db.query('SELECT count(*)::int AS n FROM itm')).rows[0].n;
    // 日曜を除く過去の日（今日は含めない：試験で記入する）
    await step('日報', `INSERT INTO daily_reports (report_date) SELECT d::date FROM generate_series(current_date - $1::int, current_date - 1, '1 day') d WHERE extract(dow FROM d) <> 0`, [Math.round(days * 7 / 6)]);
    const uid = (await db.query(`SELECT id FROM users WHERE login_id = 'reception'`)).rows[0].id;
    await db.query('ALTER TABLE report_rows DISABLE TRIGGER USER'); await db.query('ALTER TABLE trips DISABLE TRIGGER USER');
    await step('日報の行（1日80行）', `INSERT INTO report_rows (daily_report_id, customer_id, site_id, vehicle_id, item_id, vehicle_class_id, sort_order, created_by)
      SELECT r.id, v.customer_id, CASE WHEN k % 4 = 0 THEN NULL ELSE v.site_id END, v.id, i.id, v.vc, k, $1
      FROM daily_reports r CROSS JOIN generate_series(0, 79) k
      JOIN veh v ON v.n = ((extract(doy FROM r.report_date)::int * 37 + k * 13) % 1000)
      JOIN itm i ON i.n = (k % $2)`, [uid, ni]);
    // 1行に1〜7便（平均およそ3.8便＝1日約300便）。時刻は 7:00〜16:59
    await step('便', `INSERT INTO trips (daily_report_id, trip_date, report_row_id, trip_time, effective_item_id, client_op_id, created_by)
      SELECT rr.daily_report_id, r.report_date, rr.id, make_time(7 + ((t * 2 + rr.sort_order) % 10), (t * 17 + rr.sort_order * 7) % 60, 0), rr.item_id, gen_random_uuid(), rr.created_by
      FROM report_rows rr JOIN daily_reports r ON r.id = rr.daily_report_id
      CROSS JOIN LATERAL generate_series(1, 1 + ((rr.sort_order * 7 + extract(day FROM r.report_date)::int) % 6) + (rr.sort_order % 3 = 0)::int) t`);
    await db.query('ALTER TABLE report_rows ENABLE TRIGGER USER'); await db.query('ALTER TABLE trips ENABLE TRIGGER USER');
    await step('統計の更新', 'ANALYZE');
    const n = (await db.query(`SELECT (SELECT count(*) FROM daily_reports) d, (SELECT count(*) FROM report_rows) r, (SELECT count(*) FROM trips) t`)).rows[0];
    console.log(`できました：日報 ${n.d} 日・行 ${n.r} 件・便 ${n.t} 件（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  } finally { await db.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
