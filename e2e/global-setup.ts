/* E2E の準備：API で請求先・客先・現場・車番と、先月の便（締めの試験用）を作る。作った ID は .state.json へ */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'http://localhost:4100/api/v1';
export const PASSWORD = 'e2e-correct-horse-battery';

class Client {
  cookie = ''; csrf = '';
  static async login(loginId: string) {
    const c = new Client();
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: PASSWORD }) });
    if (!r.ok) throw new Error(`login ${loginId}: ${r.status} ${await r.text()}`);
    c.cookie = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
    c.csrf = (await r.json()).me.csrfToken;
    return c;
  }
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await fetch(`${API}${path}`, { method, headers: { cookie: this.cookie, 'x-csrf-token': this.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t}`);
    return (t ? JSON.parse(t) : undefined) as T;
  }
}

const jst = () => new Date(Date.now() + 9 * 3600_000).toISOString();
function lastMonthDay(day: number) { const d = new Date(jst().slice(0, 10)); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); d.setUTCDate(day); return d.toISOString().slice(0, 10); }

export default async function globalSetup() {
  if (process.env.E2E_SKIP_SETUP) return;
  const office = await Client.login('office');
  const reception = await Client.login('reception');
  const items = await office.call<{ id: string; reportLabel: string; priceItemName: string; direction: string }[]>('GET', '/masters/items');
  const vcs = await office.call<{ id: string; name: string }[]>('GET', '/masters/vehicleClasses');
  const zando = items.find((i) => i.reportLabel === '残土' && i.direction === 'RECEIVE')!;
  const v10 = vcs.find((v) => v.name === '10t')!; const v4 = vcs.find((v) => v.name === '4t') ?? vcs[1];
  const bp = (name: string, kana: string, mail: string) => office.call('POST', '/masters/billingParties', { name, kana, mailTo: [mail], closingDay: 0, paymentMonthOffset: 1, paymentDay: 0 });
  const kaya = await bp('かや工業', 'かやこうぎょう', 'kaya@example.jp');
  const sanko = await bp('三幸工務店', 'さんこうこうむてん', 'sanko@example.jp');
  const motouke = await bp('岡山土建', 'おかやまどけん', 'okadoken@example.jp');
  const cKaya = await office.call('POST', '/masters/customers', { name: 'かや工業', kana: 'かやこうぎょう', defaultBillingPartyId: kaya.id });
  const cSanko = await office.call('POST', '/masters/customers', { name: '三幸工務店', kana: 'さんこうこうむてん', defaultBillingPartyId: sanko.id });
  // ケースC：現場の既定の請求先が客先と違う（11 2章）
  const sKita = await office.call('POST', '/masters/sites', { customerId: cKaya.id, name: '北区造成', kana: 'きたくぞうせい' });
  const sMinami = await office.call('POST', '/masters/sites', { customerId: cKaya.id, name: '南工区（元請 岡山土建）', kana: 'みなみこうく', defaultBillingPartyId: motouke.id });
  const sSanko = await office.call('POST', '/masters/sites', { customerId: cSanko.id, name: '東町新築', kana: 'ひがしまちしんちく' });
  await office.call('POST', '/masters/vehicles', { customerId: cKaya.id, vehicleNo: '1234', defaultVehicleClassId: v10.id });
  await office.call('POST', '/masters/vehicles', { customerId: cKaya.id, vehicleNo: '5678', defaultVehicleClassId: v10.id });
  await office.call('POST', '/masters/vehicles', { customerId: cSanko.id, vehicleNo: '2222', defaultVehicleClassId: v4.id });

  // 先月の便（締め・確認・メール・freee・取消して再発行の試験）
  const date = lastMonthDay(10);
  await reception.call('GET', `/daily-reports/${date}`);
  const rowK = await reception.call('POST', '/report-rows', { date, customerId: cKaya.id, siteId: sKita.id, vehicleNo: '1234', itemId: zando.id, vehicleClassId: v10.id });
  const rowS = await reception.call('POST', '/report-rows', { date, customerId: cSanko.id, siteId: sSanko.id, vehicleNo: '2222', itemId: zando.id, vehicleClassId: v4.id });
  for (const [row, time] of [[rowK, '09:10'], [rowK, '10:20'], [rowK, '13:40'], [rowS, '11:05']] as const) await reception.call('POST', '/trips', { date, rowIds: [row.id], time, clientOpId: crypto.randomUUID() });

  writeFileSync(join(__dirname, '.state.json'), JSON.stringify({ lastMonthDate: date, items: { zando: zando.id }, bp: { kaya: kaya.id, sanko: sanko.id, motouke: motouke.id }, customers: { kaya: cKaya.id, sanko: cSanko.id }, sites: { kita: sKita.id, minami: sMinami.id, sanko: sSanko.id } }, null, 2));
}
