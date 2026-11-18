/*
 * prisma/migrations/<番号>_<名前>/migration.sql を番号の順に1回ずつ流す（流した記録は sf_schema_migrations）。
 * Prisma の schema-engine に頼らず、Cloud Run のジョブ・CI・ローカルで同じ手順で使う。
 *   pnpm --filter api db:migrate
 */
import 'dotenv/config';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';

/** apps/api（tsx で動かすときも、dist/ にビルドしたものを動かすときも同じ場所） */
export const API_ROOT = __dirname.includes(`${sep}dist${sep}`) ? join(__dirname, '..', '..') : join(__dirname, '..');
import { Client } from 'pg';

export async function migrate(url = process.env.DATABASE_URL, log = console.log) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('CREATE TABLE IF NOT EXISTS sf_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await db.query('SELECT pg_advisory_lock(73010001)');
    const done = new Set((await db.query('SELECT name FROM sf_schema_migrations')).rows.map((r) => r.name as string));
    const dir = join(API_ROOT, 'prisma', 'migrations');
    for (const name of readdirSync(dir).filter((d) => existsSync(join(dir, d, 'migration.sql'))).sort()) {
      if (done.has(name)) continue;
      await db.query('BEGIN');
      try {
        await db.query(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
        await db.query('INSERT INTO sf_schema_migrations(name) VALUES ($1)', [name]);
        await db.query('COMMIT');
        log(`applied ${name}`);
      } catch (e) { await db.query('ROLLBACK'); throw e; }
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(73010001)').catch(() => undefined);
    await db.end();
  }
}
if (require.main === module) migrate().catch((e) => { console.error(e); process.exit(1); });
