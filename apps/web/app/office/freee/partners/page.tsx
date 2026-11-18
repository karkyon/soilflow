'use client';
/* SCR-42 取引先の対応付け（FR-FRE-06・07）。名前で自動照合・候補から選ぶ・freee に作る */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dialog, Empty, ErrorBox, errMsg, Input, Loading, PageHead, Pill, Table, Td, Th, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { useMe } from '@/lib/auth';

interface Mapping { billingPartyId: string; billingPartyName: string; freeePartnerId: number | null; freeePartnerName: string | null; status: string; candidates: { id: number; name: string }[] }
const ST: Record<string, [string, 'ok' | 'warn' | 'gray' | 'info']> = { UNMAPPED: ['未対応付け', 'warn'], AUTO: ['自動照合', 'ok'], CANDIDATE: ['候補あり（要確認）', 'warn'], MANUAL: ['手で選択', 'ok'], CREATED: ['freee に作成', 'info'] };

export default function PartnersPage() {
  const admin = useMe().role === 'ADMIN'; const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['partner-maps'], queryFn: () => api.get<Mapping[]>('/freee/partner-mappings') });
  const [busy, setBusy] = useState<string | null>(null); const [pick, setPick] = useState<Mapping | null>(null); const [kw, setKw] = useState('');
  const search = useQuery({ queryKey: ['freee-partners', kw, !!pick], enabled: !!pick, queryFn: () => api.get<{ id: number; name: string; code: string | null }[]>('/freee/partners', { keyword: kw }) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['partner-maps'] });
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => { setBusy(key); try { await fn(); toast(msg); refresh(); setPick(null); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(null); } };
  return (
    <div className="space-y-4">
      <PageHead title="取引先の対応付け" sub="請求先を freee の取引先に対応付けます。対応付けがない請求書は freee に登録できません（要対応）"
        actions={admin && <Button kind="freee" busy={busy === 'auto'} onClick={() => run('auto', () => api.post('/freee/partner-mappings/auto-match'), '名前で自動照合しました')}>名前で自動照合</Button>} />
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty>請求先がありません</Empty> : (
        <Table head={<><Th>請求先（SoilFlow）</Th><Th>freee の取引先</Th><Th>状態</Th><Th className="w-[360px]">操作</Th></>}>
          {q.data.map((m) => (
            <tr key={m.billingPartyId}>
              <Td className="font-bold">{m.billingPartyName}</Td><Td>{m.freeePartnerName ?? '—'}{m.freeePartnerId && <span className="ml-1 text-xs text-gray-500">ID {m.freeePartnerId}</span>}
                {m.candidates.length > 0 && <div className="mt-1 text-xs text-gray-600">候補：{m.candidates.map((c) => admin ? <button key={c.id} className="mr-2 text-info hover:underline" onClick={() => run(`c${m.billingPartyId}`, () => api.put(`/billing-parties/${m.billingPartyId}/freee-partner`, { freeePartnerId: c.id }), `${c.name} に対応付けました`)}>{c.name}</button> : <span key={c.id} className="mr-2">{c.name}</span>)}</div>}</Td>
              <Td><Pill tone={ST[m.status]?.[1]}>{ST[m.status]?.[0]}</Pill></Td>
              <Td>{admin && <div className="flex flex-wrap gap-1">
                <Button size="sm" onClick={() => { setKw(m.billingPartyName.replace(/株式会社|有限会社/g, '')); setPick(m); }}>freee から選ぶ</Button>
                {!m.freeePartnerId && <Button size="sm" busy={busy === `n${m.billingPartyId}`} onClick={() => run(`n${m.billingPartyId}`, () => api.post('/freee/partners', { billingPartyId: m.billingPartyId }), `freee に取引先「${m.billingPartyName}」を作りました`)}>freee に作る</Button>}
                {m.freeePartnerId && <Button size="sm" kind="ghost" onClick={() => run(`x${m.billingPartyId}`, () => api.put(`/billing-parties/${m.billingPartyId}/freee-partner`, { freeePartnerId: null }), '対応付けを外しました')}>外す</Button>}
              </div>}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog open={!!pick} onClose={() => setPick(null)} title={`freee の取引先を選ぶ（${pick?.billingPartyName ?? ''}）`} width={520}>
        <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="名前で検索" />
        <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {search.isLoading ? <Loading /> : search.error ? <ErrorBox error={search.error} /> : !search.data?.length ? <Empty>見つかりません</Empty> : search.data.map((p) => (
            <button key={p.id} type="button" className="flex w-full justify-between rounded border border-line px-3 py-2 text-left text-sm hover:bg-gold-pale"
              onClick={() => run(`p${p.id}`, () => api.put(`/billing-parties/${pick!.billingPartyId}/freee-partner`, { freeePartnerId: p.id }), `${p.name} に対応付けました`)}><span>{p.name}</span><span className="text-xs text-gray-500">ID {p.id}{p.code && `・${p.code}`}</span></button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
