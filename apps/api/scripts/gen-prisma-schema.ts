/*
import 'dotenv/config';
 * DB（migrations の SQL を流したもの）から prisma/schema.prisma を作る。
 * DB の正本は SQL（docs/spec/schema.sql → prisma/migrations）。Prisma のモデルは型付きの読み書きのためだけに使い、
 * リレーションは書かない（結合は明示的なクエリで行う）。
 *   pnpm --filter api db:schema   （DATABASE_URL の DB を読む）
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => { const c = camel(s); return c[0].toUpperCase() + c.slice(1); };
const singular = (t: string) => {
  const special: Record<string, string> = {
    settings: 'Setting', billing_parties: 'BillingParty', price_table_entries: 'PriceTableEntry', vehicle_classes: 'VehicleClass',
    freee_connection: 'FreeeConnection', freee_oauth_states: 'FreeeOauthState', freee_api_logs: 'FreeeApiLog', mark_rules: 'MarkRule',
    invoice_trips: 'InvoiceTrip', mail_logs: 'MailLog', audit_logs: 'AuditLog', slip_counters: 'SlipCounter', invoice_counters: 'InvoiceCounter',
  };
  if (special[t]) return special[t];
  return pascal(t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.endsWith('ses') ? t.slice(0, -2) : t.replace(/s$/, ''));
};

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const tables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT LIKE 'sf_schema%' ORDER BY table_name`)).rows.map((r) => r.table_name as string);
  const out: string[] = [
    '// 自動生成（apps/api/scripts/gen-prisma-schema.ts）。手で直さない。DB の正本は prisma/migrations の SQL',
    'generator client {', '  provider     = "prisma-client"', '  output       = "../src/generated/prisma"', '  moduleFormat = "cjs"', '}', '',
    'datasource db {', '  provider = "postgresql"', '}', '',
  ];
  for (const t of tables) {
    const cols = (await db.query(`
      SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.datetime_precision
      FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=$1 ORDER BY c.ordinal_position`, [t])).rows;
    const pk = (await db.query(`
      SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [t])).rows.map((r) => r.attname as string);
    const uniques = (await db.query(`
      SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum)) AS cols FROM pg_index i
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL AND i.indexprs IS NULL
      GROUP BY i.indexrelid`, [t])).rows.map((r) => r.cols as string[]);
    out.push(`model ${singular(t)} {`);
    for (const c of cols) {
      const n = c.column_name as string; const nullable = c.is_nullable === 'YES'; const def = c.column_default as string | null;
      let type = 'String'; let attr = '';
      switch (c.udt_name) {
        case 'uuid': type = 'String'; attr = '@db.Uuid'; break;
        case 'text': type = 'String'; break;
        case 'bpchar': type = 'String'; attr = `@db.Char(${c.character_maximum_length})`; break;
        case 'int2': type = 'Int'; attr = '@db.SmallInt'; break;
        case 'int4': type = 'Int'; break;
        case 'int8': type = 'BigInt'; break;
        case 'bool': type = 'Boolean'; break;
        case 'timestamptz': type = 'DateTime'; attr = `@db.Timestamptz(${c.datetime_precision ?? 6})`; break;
        case 'date': type = 'DateTime'; attr = '@db.Date'; break;
        case 'time': type = 'DateTime'; attr = `@db.Time(${c.datetime_precision ?? 0})`; break;
        case 'numeric': type = 'Decimal'; attr = `@db.Decimal(${c.numeric_precision}, ${c.numeric_scale})`; break;
        case 'jsonb': type = 'Json'; break;
        case 'bytea': type = 'Bytes'; break;
        case 'inet': type = 'String'; attr = '@db.Inet'; break;
        case '_text': type = 'String[]'; break;
        case 'interval': type = 'Unsupported("interval")'; break;
        default: throw new Error(`未対応の型 ${t}.${n} ${c.udt_name}`);
      }
      const parts = [camel(n), type + (nullable && !type.endsWith('[]') ? '?' : '')];
      if (pk.length === 1 && pk[0] === n) parts.push('@id');
      if (def) {
        if (def.startsWith('nextval(')) parts.push('@default(autoincrement())');
        else if (def === 'gen_random_uuid()') parts.push('@default(dbgenerated("gen_random_uuid()"))');
        else if (def === 'now()') parts.push('@default(now())');
        else if (def === 'true' || def === 'false') parts.push(`@default(${def})`);
        else if (/^-?\d+$/.test(def)) parts.push(`@default(${def})`);
        else parts.push(`@default(dbgenerated(${JSON.stringify(def)}))`);
      }
      if (uniques.some((u) => u.length === 1 && u[0] === n) && !(pk.length === 1 && pk[0] === n)) parts.push('@unique');
      if (camel(n) !== n) parts.push(`@map("${n}")`);
      if (attr) parts.push(attr);
      out.push('  ' + parts.join(' '));
    }
    if (pk.length > 1) out.push(`\n  @@id([${pk.map(camel).join(', ')}])`);
    for (const u of uniques.filter((x) => x.length > 1)) out.push(`  @@unique([${u.map(camel).join(', ')}])`);
    out.push(`  @@map("${t}")`, '}', '');
  }
  writeFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), out.join('\n'));
  await db.end();
  console.log(`schema.prisma: ${tables.length} テーブル`);
}
main().catch((e) => { console.error(e); process.exit(1); });
