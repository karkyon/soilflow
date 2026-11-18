/* freee会計 API（IF-01、09 3・4章）。HTTP の呼び出しだけを持ち、手順・記録・再試行は FreeeService が行う。
 * ローカル・試験は FakeFreee（同じ応答の形を返すにせもの） */
import { randomBytes } from 'node:crypto';
import { config } from '../common/config';

export const FREEE = Symbol('FREEE');
export interface FreeeTokenResponse { access_token: string; refresh_token: string; expires_in: number; company_id?: number | null; token_type?: string }
export interface FreeeRequest {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: { fields: Record<string, string | number>; file?: { field: string; name: string; data: Buffer; type: string } };
}
/** status 0＝通信エラー・時間切れ */
export class FreeeError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) { super(message); }
  get freeeMessage(): string {
    const b = this.body as { errors?: { messages?: string[] }[]; message?: string; error_description?: string } | null;
    return b?.errors?.flatMap((e) => e.messages ?? []).join(' / ') || b?.message || b?.error_description || this.message;
  }
}
export interface FreeeAdapter {
  authorizeUrl(state: string): string;
  token(form: Record<string, string>): Promise<FreeeTokenResponse>;
  request<T = unknown>(accessToken: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts?: FreeeRequest): Promise<{ status: number; data: T }>;
}

export class HttpFreee implements FreeeAdapter {
  authorizeUrl(state: string) {
    const q = new URLSearchParams({ response_type: 'code', client_id: config.freeeClientId, redirect_uri: config.freeeRedirectUri, state, prompt: 'select_company' });
    return `${config.freeeAuthBase}/public_api/authorize?${q}`;
  }
  async token(form: Record<string, string>) {
    const body = new URLSearchParams({ ...form, client_id: config.freeeClientId, client_secret: config.freeeClientSecret, ...(form.grant_type === 'authorization_code' ? { redirect_uri: config.freeeRedirectUri } : {}) });
    let res: Response;
    try {
      res = await fetch(`${config.freeeAuthBase}/public_api/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30000) });
    } catch (e) { throw new FreeeError(0, null, `freee に接続できません（${(e as Error).message}）`); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new FreeeError(res.status, data, `freee の鍵の発行・更新に失敗（${res.status}）`);
    return data as FreeeTokenResponse;
  }
  async request<T>(accessToken: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: FreeeRequest = {}) {
    const url = new URL(`${config.freeeApiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, 'X-Api-Version': '2020-06-15', Accept: 'application/json' };
    let body: string | FormData | undefined;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    if (opts.form) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(opts.form.fields)) fd.append(k, String(v));
      if (opts.form.file) fd.append(opts.form.file.field, new Blob([new Uint8Array(opts.form.file.data)], { type: opts.form.file.type }), opts.form.file.name);
      body = fd;
    }
    let res: Response;
    try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new FreeeError(0, null, `freee に接続できません（${(e as Error).message}）`); }
    const text = await res.text();
    let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new FreeeError(res.status, data, `freee の応答 ${res.status}`);
    return { status: res.status, data: data as T };
  }
}

/* ------------------------------------------------------------------ にせもの */
interface FakeDeal { id: number; company_id: number; type: string; issue_date: string; due_date?: string; partner_id: number; ref_number: string; details: unknown[]; receipt_ids: number[]; payments: unknown[] }
export class FakeFreee implements FreeeAdapter {
  companies = [{ id: 3141592, name: 'fujimoto', display_name: '株式会社フジモト', role: 'admin' }];
  partners: { id: number; name: string; code: string | null }[] = [
    [5001, '三幸工務店'], [5002, '糸島組'], [5003, 'かや工業'], [5004, '沢田建材'], [5005, 'タカノリ産業株式会社'],
    [5006, '富士コーポレーション'], [5007, '山陽建設株式会社'], [5008, '丸山運送'], [5009, '岡山土建'],
  ].map(([id, name]) => ({ id: id as number, name: name as string, code: null }));
  accountItems = [{ id: 101, name: '売上高', account_category: '売上高' }, { id: 102, name: '雑収入', account_category: '営業外収益' }];
  taxes = [{ code: 129, name: 'sales_with_tax_10', name_ja: '課税売上10%', available: true }, { code: 2, name: 'non_taxable', name_ja: '対象外', available: true }];
  items = [[1001, '残土受入'], [1002, '泥土受入'], [1003, '真砂土'], [1004, '改良土'], [1005, '雑石受入'], [1006, 'ストックヤード']].map(([id, name]) => ({ id: id as number, name: name as string }));
  receipts: { id: number; description: string; size: number }[] = [];
  deals: FakeDeal[] = [];
  private seq = { receipt: 770001, deal: 880001, partner: 5100 };
  private refreshTokens = new Set<string>();
  /** 次に一致する呼び出しを失敗させる（試験・デモ用） */
  failures: { method?: string; path: RegExp; status: number; body?: unknown; times?: number }[] = [];
  /** 事業所を決めずに許可されたことにする（COMPANY_REQUIRED の試験） */
  omitCompanyId = false;

  /** にせもの：freee の画面を通らず、すぐ戻り先へ（ローカル・E2E で連携の流れを試すため） */
  authorizeUrl(state: string) { return `${config.publicBaseUrl}/api/v1/freee/oauth/callback?code=fake-code&state=${state}`; }
  private issue(): FreeeTokenResponse {
    const rt = randomBytes(16).toString('hex'); this.refreshTokens.add(rt);
    return { access_token: `at-${randomBytes(8).toString('hex')}`, refresh_token: rt, expires_in: 21600, token_type: 'bearer', company_id: this.omitCompanyId ? null : this.companies[0].id };
  }
  async token(form: Record<string, string>) {
    this.fail('POST', '/public_api/token');
    if (form.grant_type === 'authorization_code') { if (form.code === 'bad') throw new FreeeError(400, { error: 'invalid_grant' }, 'invalid_grant'); return this.issue(); }
    if (!this.refreshTokens.delete(form.refresh_token)) throw new FreeeError(401, { error: 'invalid_grant', error_description: 'refresh token is invalid' }, 'invalid_grant');
    return this.issue();
  }
  /** にせもの側で鍵を無効にする（再連携の試験） */
  revokeAll() { this.refreshTokens.clear(); }
  private fail(method: string, path: string) {
    const i = this.failures.findIndex((f) => (!f.method || f.method === method) && f.path.test(path));
    if (i < 0) return;
    const f = this.failures[i];
    if (!f.times || f.times <= 1) this.failures.splice(i, 1); else f.times--;
    throw new FreeeError(f.status, f.body ?? { errors: [{ messages: [`にせもののエラー ${f.status}`] }] }, `freee の応答 ${f.status}`);
  }
  async request<T>(_token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: FreeeRequest = {}): Promise<{ status: number; data: T }> {
    this.fail(method, path);
    const q = opts.query ?? {}; const j = (opts.json ?? {}) as Record<string, unknown>;
    const ok = (data: unknown, status = 200) => ({ status, data: data as T });
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/api/1/companies') return ok({ companies: this.companies });
    if (method === 'GET' && (m = /^\/api\/1\/companies\/(\d+)$/.exec(path))) return ok({ company: this.companies.find((c) => c.id === Number(m![1])) });
    if (method === 'GET' && path === '/api/1/users/me') return ok({ user: { email: 'admin@fujimoto.example' } });
    if (method === 'GET' && path === '/api/1/partners') {
      const kw = String(q.keyword ?? ''); const list = this.partners.filter((p) => !kw || p.name.includes(kw));
      const off = Number(q.offset ?? 0), lim = Number(q.limit ?? 100);
      return ok({ partners: list.slice(off, off + lim) });
    }
    if (method === 'POST' && path === '/api/1/partners') { const p = { id: this.seq.partner++, name: String(j.name), code: (j.code as string) ?? null }; this.partners.push(p); return ok({ partner: p }, 201); }
    if (method === 'GET' && path === '/api/1/account_items') return ok({ account_items: this.accountItems });
    if (method === 'GET' && /^\/api\/1\/taxes\/companies\/\d+$/.test(path)) return ok({ taxes: this.taxes });
    if (method === 'GET' && path === '/api/1/items') return ok({ items: this.items });
    if (method === 'POST' && path === '/api/1/receipts') {
      const r = { id: this.seq.receipt++, description: String(opts.form?.fields.description ?? ''), size: opts.form?.file?.data.length ?? 0 };
      this.receipts.push(r); return ok({ receipt: r }, 201);
    }
    if (method === 'GET' && path === '/api/1/deals') {
      const list = this.deals.filter((d) => (!q.partner_id || d.partner_id === Number(q.partner_id)) && (!q.start_issue_date || d.issue_date >= String(q.start_issue_date)) && (!q.end_issue_date || d.issue_date <= String(q.end_issue_date)) && (!q.type || d.type === q.type));
      return ok({ deals: list, meta: { total_count: list.length } });
    }
    if (method === 'POST' && path === '/api/1/deals') {
      const d: FakeDeal = { id: this.seq.deal++, company_id: Number(j.company_id), type: String(j.type), issue_date: String(j.issue_date), due_date: j.due_date as string, partner_id: Number(j.partner_id), ref_number: String(j.ref_number), details: (j.details as unknown[]) ?? [], receipt_ids: (j.receipt_ids as number[]) ?? [], payments: [] };
      this.deals.push(d); return ok({ deal: d }, 201);
    }
    if ((m = /^\/api\/1\/deals\/(\d+)$/.exec(path))) {
      const id = Number(m[1]); const d = this.deals.find((x) => x.id === id);
      if (!d) throw new FreeeError(404, { errors: [{ messages: ['取引が見つかりません'] }] }, 'freee の応答 404');
      if (method === 'GET') return ok({ deal: d });
      if (method === 'PUT') { Object.assign(d, { issue_date: j.issue_date, due_date: j.due_date, partner_id: j.partner_id, ref_number: j.ref_number, details: j.details, receipt_ids: j.receipt_ids }); return ok({ deal: d }); }
      if (method === 'DELETE') { this.deals = this.deals.filter((x) => x.id !== id); return ok(null, 204); }
    }
    throw new FreeeError(404, { errors: [{ messages: [`にせものにない API ${method} ${path}`] }] }, 'freee の応答 404');
  }
}
