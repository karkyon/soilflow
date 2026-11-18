'use client';
/* SCR-30 状況（FR-AGG-01）。30秒ごとに読み直す */
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Alert, Card, ErrorBox, FREEE_STATUS, INVOICE_STATUS, Loading, PageHead, Pill } from '@/components/ui';
import { api } from '@/lib/api/client';
import { jdate } from '@/lib/format';

interface Dash { today: { date: string; tripCount: number; awaitingSignature: number; unslippedTrips: number }; invoices: Record<string, number>; freee: { connection: { status: string; companyName: string | null; registrationMode: string }; counts: Record<string, number> }; alerts: { code: string; message: string; link: string }[] }
const CONN: Record<string, [string, 'ok' | 'warn' | 'err' | 'gray']> = { CONNECTED: ['連携中', 'ok'], DISCONNECTED: ['未連携', 'gray'], COMPANY_REQUIRED: ['事業所の選択待ち', 'warn'], REAUTH_REQUIRED: ['再連携が必要', 'err'] };
const Num = ({ label, value, href }: { label: string; value: number; href?: string }) => {
  const body = <div className="rounded-lg border border-line bg-cream/50 p-3"><div className="text-xs text-gray-600">{label}</div><div className="text-2xl font-bold text-navy num">{value}</div></div>;
  return href ? <Link href={href} className="hover:opacity-80">{body}</Link> : body;
};

export default function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dash>('/dashboard'), refetchInterval: 30000 });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <PageHead title="状況" sub={jdate(d.today.date)} />
      <Card title="対応が必要なこと">
        {!d.alerts.length ? <p className="text-sm text-ok">対応が必要なことはありません。</p> : (
          <div className="space-y-2">{d.alerts.map((a) => <Link key={a.code} href={a.link} className="block"><Alert tone={a.code.includes('ERROR') || a.code.includes('REAUTH') || a.code === 'JOB_FAILED' ? 'err' : 'warn'}>{a.message} →</Alert></Link>)}</div>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="本日の受入">
          <div className="grid grid-cols-3 gap-2"><Num label="台数" value={d.today.tripCount} href="/office/report/" /><Num label="サイン待ち" value={d.today.awaitingSignature} href="/office/slips/" /><Num label="伝票未発行の便" value={d.today.unslippedTrips} href="/office/slips/" /></div>
        </Card>
        <Card title="請求書">
          <div className="grid grid-cols-3 gap-2">{Object.entries(INVOICE_STATUS).filter(([k]) => k !== 'VOIDED').map(([k, [l]]) => <Num key={k} label={l} value={d.invoices[k] ?? 0} href={`/office/billing/?status=${k}`} />)}</div>
        </Card>
        <Card title="freee 会計" actions={<Pill tone={CONN[d.freee.connection.status]?.[1]}>{CONN[d.freee.connection.status]?.[0]}</Pill>}>
          <p className="mb-2 text-sm">{d.freee.connection.companyName ?? '—'}　登録のしかた：{d.freee.connection.registrationMode === 'AUTO' ? '自動で登録' : '確認してから登録'}</p>
          <div className="grid grid-cols-3 gap-2">{['PENDING', 'NEEDS_ACTION', 'ERROR', 'QUEUED', 'REGISTERED', 'DELETED'].map((k) => <Num key={k} label={FREEE_STATUS[k][0]} value={d.freee.counts[k] ?? 0} href={`/office/freee/?status=${k}`} />)}</div>
        </Card>
      </div>
    </div>
  );
}
