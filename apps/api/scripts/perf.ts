/*
 * 性能試験（15 2.6 PT-01〜05）。scripts/perf-seed.ts で作った DB で API を立ち上げてから流す。
 *   PERF_API=http://localhost:4200 tsx scripts/perf.ts [--history=0] [--concurrency-sec=60]
 *   --history=N … 締めの試験の前に、さらに前の N か月を締めておく（請求書を増やす。1か月50件）
 * 結果は表で出し、目標を外れたら終了コード 1
 */
const API = `${process.env.PERF_API ?? 'http://localhost:4200'}/api/v1`;
const PASSWORD = 'perf-correct-horse-battery';
const arg = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);

class C {
  cookie = ''; csrf = '';
  static async login(id: string) {
    const c = new C();
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: PASSWORD }) });
    if (!r.ok) throw new Error(`login ${id} ${r.status} ${await r.text()}`);
    c.cookie = r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; '); c.csrf = ((await r.json()) as { me: { csrfToken: string } }).me.csrfToken;
    return c;
  }
  async req<T = any>(method: string, path: string, body?: unknown): Promise<{ ms: number; data: T; status: number }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = performance.now();
    const r = await fetch(`${API}${path}`, { method, headers: { cookie: this.cookie, 'x-csrf-token': this.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); const ms = performance.now() - s;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 300)}`);
    return { ms, data: (t ? JSON.parse(t) : undefined) as T, status: r.status };
  }
}

const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? NaN; };
const jst = () => new Date(Date.now() + 9 * 3600_000).toISOString();
const monthAdd = (ym: string, n: number) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { id: string; what: string; value: string; target: string; ok: boolean }[] = [];
const record = (id: string, what: string, ms: number, limit: number, unit = 'ms') => results.push({ id, what, value: unit === 's' ? `${(ms / 1000).toFixed(1)}秒` : `${ms.toFixed(0)}ms`, target: unit === 's' ? `${limit / 1000}秒以内` : `${limit}ms以内`, ok: ms <= limit });

async function main() {
  const [office, rec1, rec2, office2, tablet] = await Promise.all(['office', 'reception', 'reception2', 'admin', 'tablet1'].map((x) => C.login(x)));
  const today = jst().slice(0, 10);
  const db = (await office.req('GET', '/healthz')).data;
  console.log(`API ${API}　${db.time}`);

  // ---- PT-02 日報を開く（80行・約300便）
  const prev = (await rec1.req('GET', `/daily-reports/${today}/carry-over`)).data;
  const past = prev.fromDate as string;
  const open: number[] = [];
  for (let i = 0; i < 20; i++) open.push((await rec1.req('GET', `/daily-reports/${past}`)).ms);
  const rep = (await rec1.req('GET', `/daily-reports/${past}`)).data;
  record('PT-02', `日報を開く（${rep.rows.length}行・${rep.trips.length}便、95%値）`, p95(open), 2000);

  // ---- PT-01 マスのクリック → 保存（今日の日報へ前日の行を引き継いでから）
  const made = (await rec1.req('POST', `/daily-reports/${today}/carry-over`, { rowIds: prev.rows.map((r: { id: string }) => r.id) })).data as { id: string }[];
  const click: number[] = [];
  for (let i = 0; i < 100; i++) click.push((await rec1.req('POST', '/trips', { date: today, rowIds: [made[i % made.length].id], clientTime: new Date().toISOString(), clientOpId: crypto.randomUUID() })).ms);
  record('PT-01', 'マスのクリック → 保存の完了（95%値、画面の表示は保存を待たない）', p95(click), 1000);

  // ---- PT-03 同時に使う：受付2台が便を記入しながら5秒ごと・本社2台が5秒ごと・タブレットが2秒ごとに取りに行く
  const sec = arg('concurrency-sec', 60);
  const all: number[] = []; const lag: number[] = []; const stop = Date.now() + sec * 1000;
  const cursor: Record<string, string> = {};
  const written = new Map<string, number>(); // 便の ID → 保存した時刻
  const seenBy = new Map<string, Set<string>>();
  const poll = async (name: string, c: C, every: number) => {
    cursor[name] = (await c.req('GET', `/daily-reports/${today}`)).data.cursor; seenBy.set(name, new Set());
    while (Date.now() < stop) {
      const r = await c.req('GET', `/daily-reports/${today}/changes?since=${encodeURIComponent(cursor[name])}`); all.push(r.ms); cursor[name] = r.data.cursor;
      for (const t of r.data.trips ?? []) if (written.has(t.id) && !seenBy.get(name)!.has(t.id)) { seenBy.get(name)!.add(t.id); lag.push(Date.now() - written.get(t.id)!); }
      await sleep(every);
    }
  };
  const writer = async (c: C) => { let k = 0; while (Date.now() < stop) { const r = await c.req('POST', '/trips', { date: today, rowIds: [made[(k++ * 7) % made.length].id], clientTime: new Date().toISOString(), clientOpId: crypto.randomUUID() }); all.push(r.ms); for (const t of r.data.trips) written.set(t.id, Date.now()); await sleep(3000); } };
  const terminal = async () => { while (Date.now() < stop) { all.push((await tablet.req('GET', '/terminal/current-slip')).ms); await sleep(2000); } };
  const offPoll = async (c: C) => { while (Date.now() < stop) { all.push((await c.req('GET', '/dashboard')).ms); await sleep(15000); } };
  await Promise.all([writer(rec1), writer(rec2), poll('受付1', rec1, 5000), poll('受付2', rec2, 5000), poll('本社1', office, 5000), poll('本社2', office2, 5000), terminal(), offPoll(office)]);
  record('PT-03', `同時に使う：API の応答（${all.length} 回、95%値）`, p95(all), 1000);
  record('PT-03', `同時に使う：ほかの端末に反映（${lag.length} 回、最大）`, Math.max(...lag), 10000, 's');

  // ---- 集計（参考）：1年分を客先ごと
  const y0 = `${Number(today.slice(0, 4)) - 1}${today.slice(4, 10)}`;
  const ag = await office.req('GET', `/aggregates?from=${y0}&to=${today}&groupBy=customer`);
  record('参考', `集計（1年・客先ごと ${ag.data.rows.length} 行）`, ag.ms, 5000);

  // ---- 締め（PT-04）：先月の請求書 50件（PDF の作成を含む）
  const last = monthAdd(today.slice(0, 7), -1);
  for (let h = arg('history', 0); h >= 1; h--) {
    const m = monthAdd(last, -h); const s = performance.now();
    const r = await office.req('POST', '/billing/runs', { month: m });
    console.log(`  前の締め ${m}：${r.data.createdInvoiceIds.length} 件 ${((performance.now() - s) / 1000).toFixed(1)}秒`);
  }
  const pre = await office.req('GET', `/billing/precheck?month=${last}`);
  const s4 = performance.now();
  const run = await office.req('POST', '/billing/runs', { month: last });
  let ids: string[] = run.data.createdInvoiceIds;
  if (run.status === 202) { // 51件以上はジョブで PDF を作る
    while (true) { const inv = (await office.req('GET', `/invoices?month=${last}`)).data.items as { hasPdf: boolean }[]; if (inv.every((i) => i.hasPdf)) break; await office.req('POST', '/internal/jobs/run').catch(() => undefined); await sleep(500); }
  }
  record('PT-04', `締め：請求書 ${ids.length} 件（PDF を含む、確認 ${pre.ms.toFixed(0)}ms は別）`, performance.now() - s4, 60000, 's');

  // ---- PT-05 請求書 PDF 1件（作り直し＝計算と PDF の作成）
  const one: number[] = [];
  for (const id of ids.slice(0, 5)) { const d = (await office.req('GET', `/invoices/${id}`)).data; one.push((await office.req('POST', `/invoices/${id}/rebuild`, { version: d.version })).ms); }
  record('PT-05', '請求書 PDF 1件（作り直し、最大）', Math.max(...one), 5000, 's');
  const inv = (await office.req('GET', `/invoices?month=${last}`)).data.items as { tripCount: number }[];
  console.log(`  請求書の明細：便 ${inv.reduce((a, i) => a + i.tripCount, 0)} 件`);

  console.log('\n| ID | 内容 | 結果 | 目標 | 判定 |\n|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.id} | ${r.what} | ${r.value} | ${r.target} | ${r.ok ? 'OK' : 'NG'} |`);
  if (results.some((r) => !r.ok)) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
