'use client';
/* SCR-50〜55・57 マスタ（FR-MST-01〜06・08）。客先・現場・請求先・車番・品目・車格・印。項目の定義から一覧と入力を作る */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Dialog, Empty, ErrorBox, errMsg, Field, Input, Loading, PageHead, Pill, Select, Table, Td, Textarea, Th, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api/client';
import { BillingParty, Customer, Item, useMaster, VehicleClass } from '@/lib/masters';

type Opt = { value: string; label: string };
type FieldDef = { key: string; label: string; type: 'text' | 'number' | 'select' | 'bool' | 'emails' | 'color' | 'textarea' | 'rules'; required?: boolean; options?: 'billingParties' | 'customers' | 'vehicleClasses' | 'direction' | 'honorific' | 'closingDay' | 'paymentMonth' | 'paymentDay'; hint?: string; list?: boolean; createOnly?: boolean; nullable?: boolean; step?: string };
const DEFS: Record<string, { title: string; scr: string; fields: FieldDef[]; note?: string }> = {
  customers: { title: '客先マスタ', scr: 'SCR-50', note: '既定の請求先を空のまま登録すると、同じ名前の請求先を作って既定にします（ケースA）。運搬会社で請求は元請のときは元請を選びます（ケースB）', fields: [
    { key: 'name', label: '会社名', type: 'text', required: true, list: true }, { key: 'kana', label: '読みがな', type: 'text', required: true, list: true, hint: 'ひらがな。日報の頭文字の絞り込みに使います' },
    { key: 'defaultBillingPartyId', label: '既定の請求先', type: 'select', options: 'billingParties', list: true }, { key: 'sortOrder', label: '表示順', type: 'number', list: true }, { key: 'note', label: '備考', type: 'textarea' }] },
  sites: { title: '現場マスタ', scr: 'SCR-51', note: '現場によって請求先が変わるときだけ、既定の請求先を設定します（ケースC）', fields: [
    { key: 'customerId', label: '客先', type: 'select', options: 'customers', required: true, list: true, createOnly: true }, { key: 'name', label: '現場名', type: 'text', required: true, list: true },
    { key: 'kana', label: '読みがな', type: 'text', required: true, list: true }, { key: 'defaultBillingPartyId', label: '既定の請求先', type: 'select', options: 'billingParties', list: true, nullable: true, hint: '空なら客先の既定の請求先' }] },
  billingParties: { title: '請求先マスタ', scr: 'SCR-52', fields: [
    { key: 'name', label: '名称', type: 'text', required: true, list: true }, { key: 'kana', label: '読みがな', type: 'text', required: true }, { key: 'honorific', label: '敬称', type: 'select', options: 'honorific' },
    { key: 'postalCode', label: '郵便番号', type: 'text', hint: '000-0000', nullable: true }, { key: 'address', label: '住所', type: 'text', nullable: true },
    { key: 'mailTo', label: '送付先メール', type: 'emails', list: true, hint: '複数はカンマ区切り' }, { key: 'mailCc', label: '送付先メール（CC）', type: 'emails' },
    { key: 'closingDay', label: '締め日', type: 'select', options: 'closingDay', list: true }, { key: 'paymentMonthOffset', label: '支払月', type: 'select', options: 'paymentMonth' },
    { key: 'paymentDay', label: '支払日', type: 'select', options: 'paymentDay', list: true }, { key: 'note', label: '備考', type: 'textarea', nullable: true }] },
  vehicles: { title: '車番マスタ', scr: 'SCR-53', note: '日報で新しい車番を入れると自動で登録されます', fields: [
    { key: 'customerId', label: '客先', type: 'select', options: 'customers', required: true, list: true, createOnly: true }, { key: 'vehicleNo', label: '車番', type: 'text', required: true, list: true },
    { key: 'defaultVehicleClassId', label: 'よく使う車格', type: 'select', options: 'vehicleClasses', list: true, nullable: true }] },
  items: { title: '品目マスタ', scr: 'SCR-54', note: '日報表記は受付が選ぶ名前、価格表品目は請求書に出る名前です。参考値（㎥単価・積込料）は単価表の照合だけに使います', fields: [
    { key: 'reportLabel', label: '日報表記', type: 'text', required: true, list: true }, { key: 'priceItemName', label: '価格表品目', type: 'text', required: true, list: true },
    { key: 'direction', label: '区分', type: 'select', options: 'direction', required: true, list: true }, { key: 'pricePerM3Ref', label: '㎥単価（参考値）', type: 'number', list: true, nullable: true },
    { key: 'smallVehicleFeeRef', label: '4t車以下の積込料加算（参考値）', type: 'number' }, { key: 'sortOrder', label: '表示順', type: 'number', required: true, list: true }] },
  vehicleClasses: { title: '車格マスタ', scr: 'SCR-55', fields: [
    { key: 'name', label: '車格', type: 'text', required: true, list: true }, { key: 'capacityM3', label: '容量（㎥）', type: 'number', required: true, list: true, step: '0.1' },
    { key: 'smallVehicle', label: '4t車以下', type: 'bool', list: true }, { key: 'sortOrder', label: '表示順', type: 'number', required: true, list: true }] },
  marks: { title: '印マスタ', scr: 'SCR-57', note: '印を付けた便は、切り替え規則で品目が変わります（例：草 → 残土を残土（草根）に）。規則を変えると、送信済の請求書・伝票に入っていない便の品目を計算し直します', fields: [
    { key: 'symbol', label: '記号', type: 'text', required: true, list: true }, { key: 'displayName', label: '表示名', type: 'text', required: true, list: true },
    { key: 'color', label: '色', type: 'color', required: true }, { key: 'sortOrder', label: '表示順', type: 'number', required: true, list: true }, { key: 'rules', label: '切り替え規則', type: 'rules', list: true }] },
};
const STATIC: Record<string, Opt[]> = {
  direction: [{ value: 'RECEIVE', label: '受入れ' }, { value: 'DELIVER', label: '納品' }],
  honorific: ['御中', '様', '殿'].map((x) => ({ value: x, label: x })),
  closingDay: [{ value: '0', label: '月末' }, ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` }))],
  paymentMonth: [['0', '当月'], ['1', '翌月'], ['2', '翌々月'], ['3', '3か月後']].map(([value, label]) => ({ value, label })),
  paymentDay: [{ value: '0', label: '末日' }, ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` }))],
};
type Rec = Record<string, unknown> & { id: string; active: boolean; version: number };

export default function Page() { return <Suspense fallback={<Loading />}><Masters /></Suspense>; }

function Masters() {
  const kind = useSearchParams().get('kind') ?? 'customers'; const def = DEFS[kind];
  const toast = useToast(); const qc = useQueryClient();
  const [inactive, setInactive] = useState(false); const [filter, setFilter] = useState(''); const [edit, setEdit] = useState<Rec | 'new' | null>(null); const [off, setOff] = useState<Rec | null>(null);
  const q = useQuery({ queryKey: ['masters', kind, { includeInactive: inactive }], enabled: !!def, queryFn: () => api.get<Rec[]>(`/masters/${kind}`, { includeInactive: inactive }) });
  const bps = useMaster<BillingParty>('billingParties'); const custs = useMaster<Customer>('customers'); const vcs = useMaster<VehicleClass>('vehicleClasses'); const items = useMaster<Item>('items');
  useEffect(() => { setFilter(''); setEdit(null); }, [kind]);
  const opts = (o?: FieldDef['options']): Opt[] => o === 'billingParties' ? (bps.data ?? []).map((b) => ({ value: b.id, label: b.name })) : o === 'customers' ? (custs.data ?? []).map((c) => ({ value: c.id, label: c.name })) : o === 'vehicleClasses' ? (vcs.data ?? []).map((v) => ({ value: v.id, label: v.name })) : o ? STATIC[o] : [];
  const show = (f: FieldDef, r: Rec) => {
    const v = r[f.key];
    if (f.type === 'select') return opts(f.options).find((o) => o.value === String(v ?? ''))?.label ?? (v === null || v === undefined || v === '' ? '—' : String(v));
    if (f.type === 'bool') return v ? '○' : '';
    if (f.type === 'emails') return ((v as string[]) ?? []).join('、') || <span className="text-warn">未登録</span>;
    if (f.type === 'rules') return ((v as { fromItemId: string; toItemId: string }[]) ?? []).map((x) => `${items.data?.find((i) => i.id === x.fromItemId)?.reportLabel} → ${items.data?.find((i) => i.id === x.toItemId)?.reportLabel}`).join('、');
    return v === null || v === undefined ? '—' : String(v);
  };
  const rows = useMemo(() => (q.data ?? []).filter((r) => !filter || def.fields.some((f) => String(show(f, r)).includes(filter))), [q.data, filter]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!def) return <ErrorBox error={new Error('マスタの種類が正しくありません')} />;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['masters'] }); };
  return (
    <div className="space-y-4">
      <PageHead title={def.title} sub={def.note} actions={<><Input className="w-56" placeholder="絞り込み" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> 無効も表示</label>
        <Button kind="primary" onClick={() => setEdit('new')}>＋ 追加</Button></>} />
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !rows.length ? <Empty>登録がありません</Empty> : (
        <Table head={<>{def.fields.filter((f) => f.list).map((f) => <Th key={f.key}>{f.label}</Th>)}<Th>状態</Th><Th className="w-40" /></>}>
          {rows.map((r) => (
            <tr key={r.id} className={r.active ? '' : 'opacity-50'}>
              {def.fields.filter((f) => f.list).map((f) => <Td key={f.key} className={f.type === 'number' ? 'num' : ''}>{f.key === 'symbol' ? <b style={{ color: String(r.color) }}>{String(r.symbol)}</b> : show(f, r)}</Td>)}
              <Td>{r.active ? <Pill tone="ok">有効</Pill> : <Pill>無効</Pill>}</Td>
              <Td><div className="flex gap-1"><Button size="sm" onClick={() => setEdit(r)}>直す</Button>
                {r.active ? <Button size="sm" kind="danger" onClick={() => setOff(r)}>無効にする</Button> : <Button size="sm" onClick={async () => { try { await api.patch(`/masters/${kind}/${r.id}`, { version: r.version, active: true }); toast('有効にしました'); refresh(); } catch (e) { toast(errMsg(e), 'err'); } }}>有効に戻す</Button>}</div></Td>
            </tr>
          ))}
        </Table>
      )}
      <EditDialog kind={kind} def={def} rec={edit} onClose={() => setEdit(null)} opts={opts} items={items.data ?? []} onSaved={refresh} />
      <ConfirmDialog open={!!off} onClose={() => setOff(null)} title="無効にする" danger okLabel="無効にする" message="無効にすると、新しい行・伝票では選べなくなります（これまでの記録・請求書はそのまま残ります）。"
        onOk={async () => { await api.patch(`/masters/${kind}/${off!.id}`, { version: off!.version, active: false }); toast('無効にしました'); refresh(); }} />
    </div>
  );
}

function EditDialog({ kind, def, rec, onClose, opts, items, onSaved }: { kind: string; def: (typeof DEFS)[string]; rec: Rec | 'new' | null; onClose: () => void; opts: (o?: FieldDef['options']) => Opt[]; items: Item[]; onSaved: () => void }) {
  const toast = useToast(); const isNew = rec === 'new';
  const [v, setV] = useState<Record<string, unknown>>({}); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!rec) return;
    setErr(null); setFieldErr({});
    if (rec === 'new') setV({ ...(kind === 'billingParties' ? { honorific: '御中', closingDay: 0, paymentMonthOffset: 1, paymentDay: 0, mailTo: [], mailCc: [] } : {}), ...(kind === 'marks' ? { color: '#2c6e3f', rules: [] } : {}), ...(kind === 'items' ? { direction: 'RECEIVE', smallVehicleFeeRef: 0 } : {}) });
    else setV({ ...rec });
  }, [rec, kind]);
  if (!rec) return null;
  const set = (k: string, x: unknown) => setV((o) => ({ ...o, [k]: x }));
  const save = async () => {
    setBusy(true); setErr(null); setFieldErr({});
    const body: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (!isNew && f.createOnly) continue;
      let x = v[f.key];
      if (f.type === 'number') x = x === '' || x === undefined || x === null ? (f.nullable ? null : undefined) : Number(x);
      if (f.type === 'select' && ['closingDay', 'paymentMonth', 'paymentDay'].includes(f.options ?? '')) x = x === undefined ? undefined : Number(x);
      if (f.type === 'select' && x === '') x = f.nullable ? null : undefined;
      if ((f.type === 'text' || f.type === 'textarea') && x === '' && f.nullable) x = null;
      if (x !== undefined) body[f.key] = x;
    }
    try {
      if (isNew) await api.post(`/masters/${kind}`, body); else await api.patch(`/masters/${kind}/${(rec as Rec).id}`, { ...body, version: (rec as Rec).version });
      toast(isNew ? '追加しました' : '直しました'); onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details)) setFieldErr(Object.fromEntries((e.details as { path: string; message: string }[]).map((d) => [d.path.split('.')[0], d.message])));
      setErr(errMsg(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`${def.title}　${isNew ? '追加' : '修正'}`} width={kind === 'marks' ? 680 : 560}
      footer={<><Button onClick={onClose}>やめる</Button><Button kind="primary" busy={busy} onClick={save}>{isNew ? '追加する' : '直す'}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        {def.fields.map((f) => {
          const val = v[f.key]; const fe = fieldErr[f.key];
          const wide = ['textarea', 'rules', 'emails'].includes(f.type) || f.key === 'address';
          return (
            <div key={f.key} className={wide ? 'col-span-2' : ''}>
              {f.type === 'bool' ? <label className="mt-6 flex items-center gap-2 text-sm font-bold text-navy"><input type="checkbox" checked={!!val} onChange={(e) => set(f.key, e.target.checked)} />{f.label}</label> :
                f.type === 'rules' ? <RulesEditor value={(val as { fromItemId: string; toItemId: string }[]) ?? []} items={items} onChange={(x) => set(f.key, x)} /> : (
                <Field label={f.label} required={f.required} hint={f.hint} error={fe}>
                  {f.type === 'select' ? <Select value={val === null || val === undefined ? '' : String(val)} disabled={!isNew && f.createOnly} onChange={(e) => set(f.key, e.target.value)}>{(!f.required || isNew) && <option value="">{f.nullable || !f.required ? '（なし）' : '選んでください'}</option>}{opts(f.options).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                    : f.type === 'textarea' ? <Textarea value={String(val ?? '')} onChange={(e) => set(f.key, e.target.value)} />
                    : f.type === 'emails' ? <Input value={((val as string[]) ?? []).join(', ')} onChange={(e) => set(f.key, e.target.value.split(/[,、;\s]+/).filter(Boolean))} />
                    : f.type === 'color' ? <Input type="color" value={String(val ?? '#000000')} onChange={(e) => set(f.key, e.target.value)} className="w-24 p-1" />
                    : <Input type={f.type === 'number' ? 'number' : 'text'} step={f.step} value={val === null || val === undefined ? '' : String(val)} onChange={(e) => set(f.key, e.target.value)} className={f.type === 'number' ? 'num' : ''} />}
                </Field>
              )}
            </div>
          );
        })}
      </div>
      {err && <p className="mt-3 text-sm font-bold text-err" role="alert">{err}</p>}
    </Dialog>
  );
}

function RulesEditor({ value, items, onChange }: { value: { fromItemId: string; toItemId: string }[]; items: Item[]; onChange: (v: { fromItemId: string; toItemId: string }[]) => void }) {
  return (
    <div>
      <div className="mb-1 text-[13px] font-bold text-navy">切り替え規則（行の品目 → 印を付けたときの品目）</div>
      <div className="space-y-1">
        {value.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select value={r.fromItemId} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, fromItemId: e.target.value } : x)))}><option value="">選ぶ</option>{items.map((it) => <option key={it.id} value={it.id}>{it.reportLabel}</option>)}</Select>
            <span>→</span>
            <Select value={r.toItemId} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, toItemId: e.target.value } : x)))}><option value="">選ぶ</option>{items.map((it) => <option key={it.id} value={it.id}>{it.reportLabel}（{it.priceItemName}）</option>)}</Select>
            <Button size="sm" kind="danger" onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label="規則を消す">×</Button>
          </div>
        ))}
      </div>
      <Button size="sm" className="mt-2" onClick={() => onChange([...value, { fromItemId: '', toItemId: '' }])}>＋ 規則を足す</Button>
    </div>
  );
}
