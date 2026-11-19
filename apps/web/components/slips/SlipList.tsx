'use client';
/* SCR-15 当日の伝票一覧・控えの印刷（受付）／SCR-32 伝票（本社、期間・紙伝票のスキャンの登録） */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, ConfirmDialog, Dialog, Empty, ErrorBox, errMsg, Field, Input, Loading, PageHead, Select, SLIP_STATUS, StatusPill, Table, Td, Th, useToast } from '@/components/ui';
import { api, openFile } from '@/lib/api/client';
import { isOffice, useMe } from '@/lib/auth';
import { addDays, jdate, jdatetime, today, yen } from '@/lib/format';
import { CashDialog } from './CashDialog';

export interface Slip {
  id: string; slipNo: string; slipDate: string; status: string; customerId: string; addresseeName: string; siteName: string | null; billingPartyName: string; billingPartyChanged: boolean;
  billingChangeReason: string | null; lines: { lineNo: number; itemLabel: string; tripCount: number; vehicleNos: string }[]; tripIds: string[]; signedAt: string | null; signerName: string | null;
  hasPaperScan: boolean; lockedByInvoice: boolean; cancelReason: string | null; version: number;
  paymentMethod: 'INVOICE' | 'CASH'; cashReceipt: { id: string; receiptNo: string; total: number; version: number } | null; cashReceivable: boolean;
}

export function SlipList() {
  const me = useMe(); const office = isOffice(me.role); const toast = useToast(); const qc = useQueryClient();
  const [from, setFrom] = useState(office ? addDays(today(), -7) : today()); const [to, setTo] = useState(today()); const [status, setStatus] = useState('');
  const [printSlip, setPrintSlip] = useState<Slip | null>(null); const [cancel, setCancel] = useState<Slip | null>(null); const [scan, setScan] = useState<Slip | null>(null); const [detail, setDetail] = useState<Slip | null>(null); const [cash, setCash] = useState<string | null>(null);
  const seenSigned = useRef<Set<string> | null>(null);
  const q = useQuery({
    queryKey: ['slips', office ? from : today(), office ? to : today(), status],
    queryFn: () => api.get<{ items: Slip[]; unslipped: { customerName: string; siteName: string | null; tripCount: number }[] }>('/slips', office ? { from, to, status } : { date: today(), status }),
    refetchInterval: (qq) => (qq.state.data?.items.some((s) => s.status === 'AWAITING_SIGNATURE') ? 2000 : 15000),
  });
  // サインが確定したら控えの印刷を自動で開く（受付）
  useEffect(() => {
    if (!q.data) return;
    const signed = q.data.items.filter((s) => s.status === 'SIGNED');
    if (seenSigned.current === null) { seenSigned.current = new Set(signed.map((s) => s.id)); return; }
    const fresh = signed.find((s) => !seenSigned.current!.has(s.id));
    signed.forEach((s) => seenSigned.current!.add(s.id));
    if (fresh && !office) setPrintSlip(fresh);
  }, [q.data, office]);
  const anyCash = !!q.data?.items.some((s) => s.paymentMethod === 'CASH');
  const cashToday = useQuery({ queryKey: ['cash-today', q.data?.items.filter((s) => s.cashReceipt).length], enabled: !office && anyCash, queryFn: () => api.get<{ total: { count: number; total: number } }>('/cash-receipts') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['slips'] }); qc.invalidateQueries({ queryKey: ['cash-today'] }); };
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast(errMsg(e), 'err'); } };

  return (
    <div>
      <PageHead title={office ? '伝票' : `当日の伝票一覧　${jdate(today())}`} sub={office ? '紙伝票はスキャンした PDF を登録します（FR-SLP-11）' : 'サインが確定すると、お客さま控えの印刷が自動で開きます'}
        actions={office && <>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="から" /><span>〜</span><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="まで" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44"><option value="">すべての状態</option>{Object.entries(SLIP_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select>
        </>} />
      <ErrorBox error={q.error} />
      {!office && cashToday.data && cashToday.data.total.count > 0 && <div className="mb-4"><Alert tone="info">本日の現金：領収書 <b className="num">{cashToday.data.total.count}</b> 枚　<b className="num">¥{yen(cashToday.data.total.total)}</b>（閉める前にレジの現金と合わせてください）</Alert></div>}
      {!!q.data?.unslipped.length && <div className="mb-4"><Alert>伝票未発行の便：{q.data.unslipped.map((u) => `${u.customerName}${u.siteName ? `・${u.siteName}` : ''} ${u.tripCount}台`).join('、')}</Alert></div>}
      {q.isLoading ? <Loading /> : !q.data?.items.length ? <Empty>伝票はありません</Empty> : (
        <Table head={<><Th>番号</Th>{office && <Th>日付</Th>}<Th>宛名・現場</Th><Th className="text-right">台数</Th><Th>請求先</Th><Th>状態</Th><Th>サイン</Th><Th className="w-[340px]">操作</Th></>}>
          {q.data.items.map((s) => (
            <tr key={s.id} className={s.status === 'CANCELLED' ? 'opacity-60' : ''}>
              <Td><button className="font-bold text-info num hover:underline" onClick={() => setDetail(s)}>{s.slipNo}</button></Td>
              {office && <Td className="num">{s.slipDate}</Td>}
              <Td><b>{s.addresseeName}</b><div className="text-xs text-gray-600">{s.siteName ?? '—'}</div></Td>
              <Td className="text-right font-bold num">{s.lines.reduce((a, l) => a + l.tripCount, 0)}</Td>
              <Td>{s.billingPartyName}{s.paymentMethod === 'CASH' && <span className="ml-1 rounded bg-info-bg px-1 text-xs font-bold text-info">現金</span>}{s.billingPartyChanged && <span className="ml-1 rounded bg-warn-bg px-1 text-xs font-bold text-warn" title={s.billingChangeReason ?? ''}>変更</span>}</Td>
              <Td><StatusPill map={SLIP_STATUS} value={s.status} />{s.lockedByInvoice && <div className="mt-0.5 text-xs text-gray-500">請求書で固定</div>}</Td>
              <Td className="text-xs">{s.signedAt ? jdatetime(s.signedAt) : s.hasPaperScan ? 'スキャン登録済' : '—'}</Td>
              <Td><div className="flex flex-wrap gap-1">
                {s.status === 'DRAFT' && <Button size="sm" kind="primary" onClick={() => act(() => api.post(`/slips/${s.id}/send-to-terminal`, {}), `伝票 ${s.slipNo} をタブレットへ送りました`)}>タブレットへ送る</Button>}
                {s.status === 'AWAITING_SIGNATURE' && <Button size="sm" onClick={() => act(() => api.post(`/slips/${s.id}/withdraw`), '送信を取りやめました')}>送信を取りやめ</Button>}
                {['DRAFT', 'AWAITING_SIGNATURE', 'PAPER_PRINTED'].includes(s.status) && <Button size="sm" onClick={() => act(async () => { const w = window.open('', '_blank'); const f = await api.post<{ url: string }>(`/slips/${s.id}/print-paper`); if (w) w.location.href = f.url; }, '紙伝票を印刷します')}>紙に切替</Button>}
                {s.status === 'SIGNED' && <Button size="sm" kind="primary" onClick={() => openFile(`/slips/${s.id}/pdf`, { kind: 'signed' }).catch((e) => toast(errMsg(e), 'err'))}>控えを印刷</Button>}
                {s.cashReceivable && <Button size="sm" kind="navy" onClick={() => setCash(s.id)}>現金で受け取る</Button>}
                {s.cashReceipt && <Button size="sm" onClick={() => openFile(`/cash-receipts/${s.cashReceipt!.id}/pdf`).catch((e) => toast(errMsg(e), 'err'))}>領収書 {s.cashReceipt.receiptNo}</Button>}
                {office && ['PAPER_PRINTED', 'PAPER_SIGNED'].includes(s.status) && <Button size="sm" onClick={() => setScan(s)}>{s.hasPaperScan ? 'スキャンを登録し直す' : 'スキャンを登録'}</Button>}
                {s.hasPaperScan && <Button size="sm" kind="ghost" onClick={() => openFile(`/slips/${s.id}/pdf`, { kind: 'scan' }).catch((e) => toast(errMsg(e), 'err'))}>スキャンを見る</Button>}
                {office && s.status === 'SIGNED' && <Button size="sm" kind="ghost" onClick={() => openFile(`/slips/${s.id}/pdf`, { kind: 'office' }).catch((e) => toast(errMsg(e), 'err'))}>控え（保存用）</Button>}
                {!['CANCELLED', 'AWAITING_SIGNATURE'].includes(s.status) && !s.lockedByInvoice && <Button size="sm" kind="danger" onClick={() => setCancel(s)}>取消</Button>}
              </div></Td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog open={!!printSlip} onClose={() => setPrintSlip(null)} title="サインが確定しました" width={440}
        footer={<><Button onClick={() => setPrintSlip(null)}>あとで</Button><Button kind="primary" onClick={() => { openFile(`/slips/${printSlip!.id}/pdf`, { kind: 'signed' }).catch((e) => toast(errMsg(e), 'err')); setPrintSlip(null); }}>お客さま控えを印刷</Button></>}>
        <p>伝票 <b>{printSlip?.slipNo}</b>（{printSlip?.addresseeName} 様）にサインをいただきました。控えを印刷してお渡しください。</p>
        {printSlip?.cashReceivable && <div className="mt-3"><Alert tone="info">現金のお客さまです。代金を受け取って領収書を出してください。<Button size="sm" kind="navy" className="ml-2" onClick={() => { setCash(printSlip.id); setPrintSlip(null); }}>現金で受け取る</Button></Alert></div>}
      </Dialog>
      <CashDialog slipId={cash} onClose={() => setCash(null)} onDone={refresh} />
      <ConfirmDialog open={!!cancel} onClose={() => setCancel(null)} title={`伝票 ${cancel?.slipNo} の取消`} danger needReason okLabel="取り消す"
        message="伝票を取り消すと、含まれていた便は伝票未発行に戻ります（記録は残ります）。"
        onOk={async (reason) => { await api.post(`/slips/${cancel!.id}/cancel`, { version: cancel!.version, reason }); toast('伝票を取り消しました'); refresh(); }} />
      <ScanDialog slip={scan} onClose={() => setScan(null)} onDone={refresh} />
      <Dialog open={!!detail} onClose={() => setDetail(null)} title={`伝票 ${detail?.slipNo}`} width={600}>
        {detail && <div className="space-y-2 text-sm">
          <p><b className="text-base">{detail.addresseeName} 様</b>　現場：{detail.siteName ?? '—'}　{jdate(detail.slipDate)}</p>
          <table className="w-full"><thead><tr className="border-b text-left"><th className="py-1">品名</th><th className="text-center">台数</th><th>車番</th></tr></thead>
            <tbody>{detail.lines.map((l) => <tr key={l.lineNo} className="border-b border-line"><td className="py-1">{l.itemLabel}</td><td className="text-center num">{l.tripCount}</td><td className="text-xs">{l.vehicleNos}</td></tr>)}</tbody></table>
          <p>請求先：{detail.billingPartyName}{detail.billingPartyChanged && `（変更：${detail.billingChangeReason ?? '理由なし'}）`}</p>
          {detail.signerName && <p>サインした人：{detail.signerName}</p>}
          {detail.cancelReason && <p className="text-err">取消の理由：{detail.cancelReason}</p>}
        </div>}
      </Dialog>
    </div>
  );
}

function ScanDialog({ slip, onClose, onDone }: { slip: Slip | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setFile(null); setErr(null); }, [slip]);
  return (
    <Dialog open={!!slip} onClose={onClose} title={`紙伝票のスキャンの登録　${slip?.slipNo ?? ''}`} width={480}
      footer={<><Button onClick={onClose}>閉じる</Button><Button kind="primary" busy={busy} disabled={!file} onClick={async () => {
        setBusy(true); setErr(null);
        try { const fd = new FormData(); fd.append('file', file!); await api.post(`/slips/${slip!.id}/paper-scan`, fd); toast('スキャンを登録しました'); onDone(); onClose(); }
        catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>登録する</Button></>}>
      <Field label="スキャンした PDF（20MB まで）" error={err}><input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <p className="mt-3 text-xs text-gray-600">複合機で PDF・300dpi にしてください。登録したら、内容が伝票と合っているか画面で確かめてください。</p>
    </Dialog>
  );
}
