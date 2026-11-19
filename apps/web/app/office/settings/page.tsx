'use client';
/* SCR-62 システム設定（FR-CMN-05）。本社は参照のみ、管理者が変更 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, ErrorBox, errMsg, Field, Input, Loading, PageHead, Select, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { useMe } from '@/lib/auth';

type Settings = Record<string, string | number | boolean | null> & { version: number };
const TEXT: [string, string, string?][] = [['companyName', '会社名'], ['officeName', '事業所名'], ['postalCode', '郵便番号'], ['address', '住所'], ['tel', '電話'], ['fax', 'FAX'], ['invoiceRegistrationNo', '登録番号（インボイス）', 'T＋13桁'], ['bankAccountText', '振込先（請求書に印字）']];
const MAIL: [string, string][] = [['mailFromAddress', '送信元メールアドレス'], ['mailFromName', '送信元の表示名'], ['mailReplyTo', '返信先']];

export default function SettingsPage() {
  const admin = useMe().role === 'ADMIN'; const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [v, setV] = useState<Settings | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!v || !q.data) return <Loading />;
  const set = (k: string, x: string | number | boolean | null) => setV({ ...v, [k]: x });
  const save = async () => {
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = { version: q.data.version };
    for (const [k, x] of Object.entries(v)) if (k !== 'version' && x !== q.data[k]) body[k] = x === '' ? null : x;
    try { await api.patch('/settings', body); toast('設定を保存しました'); qc.invalidateQueries({ queryKey: ['settings'] }); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const inp = (k: string, label: string, hint?: string) => <Field key={k} label={label} hint={hint}><Input disabled={!admin} value={String(v[k] ?? '')} onChange={(e) => set(k, e.target.value)} /></Field>;
  return (
    <div className="max-w-4xl space-y-4">
      <PageHead title="システム設定" actions={admin && <Button kind="primary" busy={busy} onClick={save}>保存</Button>} />
      {!admin && <Alert tone="info">設定の変更は管理者が行います。</Alert>}
      {err && <Alert tone="err">{err}</Alert>}
      <Card title="会社・請求書"><div className="grid grid-cols-2 gap-3">{TEXT.map(([k, l, h]) => inp(k, l, h))}
        <div className="col-span-2"><Field label="請求書の備考（定型文）"><Textarea disabled={!admin} value={String(v.invoiceNote ?? '')} onChange={(e) => set('invoiceNote', e.target.value)} /></Field></div></div></Card>
      <Card title="税"><div className="grid grid-cols-3 gap-3">
        <Field label="税率（%）"><Input type="number" disabled={!admin} value={String(v.taxRate)} onChange={(e) => set('taxRate', Number(e.target.value))} /></Field>
        <Field label="消費税の端数処理" hint="請求書ごとに1回（インボイス制度）"><Select disabled={!admin} value={String(v.taxRounding)} onChange={(e) => set('taxRounding', e.target.value)}><option value="floor">切り捨て</option><option value="round">四捨五入</option><option value="ceil">切り上げ</option></Select></Field>
        <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={!!v.slipWarningEnabled} onChange={(e) => set('slipWarningEnabled', e.target.checked)} /> 締めの前に伝票未発行の便を警告</label></div></Card>
      <Card title="現金のお客さま（設計案：Q-29）"><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!admin} checked={!!v.cashPaymentEnabled} onChange={(e) => set('cashPaymentEnabled', e.target.checked)} /> 現金の領収書を使う</label>
        <p className="mt-2 text-xs text-gray-600">請求先マスタで支払い方法を「現金」にした請求先の伝票から、受付がその場で領収書を出せます。領収書を出した伝票の便は、月の締めの請求書に入りません。</p></Card>
      <Card title="受入日報"><div className="grid grid-cols-3 gap-3">
        <Field label="最初の列（時）"><Input type="number" min={0} max={23} disabled={!admin} value={String(v.reportFirstHour)} onChange={(e) => set('reportFirstHour', Number(e.target.value))} /></Field>
        <Field label="最後の列（時）" hint="範囲外の時刻の便は端の列に表示"><Input type="number" min={0} max={23} disabled={!admin} value={String(v.reportLastHour)} onChange={(e) => set('reportLastHour', Number(e.target.value))} /></Field></div></Card>
      <Card title="請求書のメール"><div className="grid grid-cols-3 gap-3">{MAIL.map(([k, l]) => inp(k, l))}</div>
        <div className="mt-3 space-y-3">
          <Field label="件名" hint="差し込み：{company} {billing_party} {year} {month} {invoice_no} {total} {due_date}"><Input disabled={!admin} value={String(v.mailSubjectTemplate ?? '')} onChange={(e) => set('mailSubjectTemplate', e.target.value)} /></Field>
          <Field label="本文"><Textarea className="min-h-48" disabled={!admin} value={String(v.mailBodyTemplate ?? '')} onChange={(e) => set('mailBodyTemplate', e.target.value)} /></Field>
        </div></Card>
    </div>
  );
}
