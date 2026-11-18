/* 試験の準備：実際の PostgreSQL（soilflow_test）を作り直し、API を立ち上げる（14 6章） */
process.env.NODE_ENV = 'test';
process.env.ADAPTERS = 'fake';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/soilflow_test';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? `/tmp/soilflow-test-${process.pid}`;
process.env.PUBLIC_BASE_URL = 'http://test.local';

import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { migrate } from '../scripts/migrate';
import { hashPassword } from '../src/modules/auth/password';
import { loginLimiter } from '../src/modules/auth/auth.module';

export const PASSWORD = 'correct-horse-battery-staple';

export async function resetDb() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.end();
  await migrate(process.env.DATABASE_URL, () => undefined);
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  // 設定と freee の連携の行だけ（マスタは試験ごとに API で作る）
  const seed = readFileSync(join(__dirname, '..', 'prisma', 'seed.sql'), 'utf8');
  const settings = /INSERT INTO settings[\s\S]*?ON CONFLICT \(id\) DO NOTHING;/.exec(seed)![0];
  await c.query(settings);
  await c.query(`UPDATE settings SET mail_from_address = 'seikyu@fujimoto.example', mail_from_name = '株式会社フジモト', tel = '086-000-0000', invoice_registration_no = 'T1234567890123'`);
  await c.query('INSERT INTO freee_connection (id) VALUES (1)');
  const hash = await hashPassword(PASSWORD);
  const users: [string, string, string, string | null, boolean][] = [
    ['admin', '管理者', 'ADMIN', 'admin@fujimoto.example', false], ['office', '本社 花子', 'OFFICE', null, false],
    ['tablet1', 'サイン用タブレット1', 'SIGN_TERMINAL', null, false], ['tablet2', 'サイン用タブレット2', 'SIGN_TERMINAL', null, false],
    ['reception', '受付 太郎', 'RECEPTION', null, false], ['admin2', '管理者2', 'ADMIN', 'admin2@fujimoto.example', true],
  ];
  for (const [l, n, r, e, mfa] of users) await c.query(`INSERT INTO users (login_id, name, role, email, password_hash, mfa_enabled, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,false)`, [l, n, r, e, hash, mfa]);
  await c.query(`UPDATE users SET paired_terminal_id = (SELECT id FROM users WHERE login_id = 'tablet1') WHERE login_id IN ('reception','office','admin')`);
  await c.end();
}

export async function startApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ bodyParser: false, logger: ['error'] });
  configureApp(app);
  await app.init();
  return app;
}

export async function sql<T = Record<string, unknown>>(q: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return (await c.query(q, params)).rows as T[]; } finally { await c.end(); }
}

/** ログインした利用者（Cookie と CSRF トークンを持つ） */
export class Api {
  agent: ReturnType<typeof request.agent>;
  csrf = '';
  me: Record<string, unknown> = {};
  constructor(readonly app: INestApplication) { this.agent = request.agent(app.getHttpServer()); }
  static async login(app: INestApplication, loginId: string, password = PASSWORD) {
    loginLimiter.reset();
    const a = new Api(app);
    const r = await a.agent.post('/api/v1/auth/login').send({ loginId, password });
    if (r.status !== 200) throw new Error(`login ${loginId}: ${r.status} ${JSON.stringify(r.body)}`);
    a.me = r.body.me; a.csrf = r.body.me.csrfToken;
    return a;
  }
  get(p: string, q?: Record<string, unknown>) { return this.agent.get(`/api/v1${p}`).query(q ?? {}); }
  post(p: string, b?: unknown) { return this.agent.post(`/api/v1${p}`).set('X-CSRF-Token', this.csrf).send(b as object); }
  patch(p: string, b?: unknown) { return this.agent.patch(`/api/v1${p}`).set('X-CSRF-Token', this.csrf).send(b as object); }
  put(p: string, b?: unknown) { return this.agent.put(`/api/v1${p}`).set('X-CSRF-Token', this.csrf).send(b as object); }
  delete(p: string) { return this.agent.delete(`/api/v1${p}`).set('X-CSRF-Token', this.csrf); }
  /** 2xx でなければ失敗にする */
  async ok<T = any>(r: request.Test | Promise<request.Response>, status?: number): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await r;
    if (status ? res.status !== status : res.status >= 300) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  }
}

export const uuid = () => crypto.randomUUID();
