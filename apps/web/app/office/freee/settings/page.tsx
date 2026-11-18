'use client';
/* SCR-41 freee 連携の設定（FR-FRE-01〜05・09）。連携の許可（OAuth2.0）・事業所・登録のしかた・解除 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, ConfirmDialog, ErrorBox, errMsg, Field, Loading, PageHead, Pill, Select, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { RequireRole } from '@/lib/auth';
import { jdatetime } from '@/lib/format';

interface Conn { status: string; companyId: number | null; companyName: string | null; authorizedFreeeUser: string | null; connectedAt: string | null; lastCheckedAt: string | null; registrationMode: 'REVIEW' | 'AUTO'; lastError: string | null; version: number }
const ST: Record<string, [string, 'ok' | 'warn' | 'err' | 'gray']> = { CONNECTED: ['連携中', 'ok'], DISCONNECTED: ['未連携', 'gray'], COMPANY_REQUIRED: ['事業所の選択待ち', 'warn'], REAUTH_REQUIRED: ['再連携が必要', 'err'] };

export default function Page() { return <RequireRole roles={['ADMIN']}><FreeeSettings /></RequireRole>; }

function FreeeSettings() {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['freee-conn'], queryFn: () => api.get<Conn>('/freee/connection') });
  const companies = useQuery({ queryKey: ['freee-companies'], enabled: q.data?.status === 'COMPANY_REQUIRED', queryFn: () => api.get<{ id: number; name: string }[]>('/freee/companies') });
  const [companyId, setCompanyId] = useState(''); const [busy, setBusy] = useState(false); const [disc, setDisc] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('result') === 'ok') toast('freee と連携しました');
    if (p.get('result') === 'error') toast(p.get('message') ?? 'freee との連携に失敗しました', 'err');
    if (p.get('result')) history.replaceState(null, '', location.pathname);
  }, [toast]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['freee-conn'] });
  const patch = async (body: Record<string, unknown>, msg: string) => { setBusy(true); try { await api.patch('/freee/connection', { version: q.data!.version, ...body }); toast(msg); refresh(); } catch (e) { toast(errMsg(e), 'err'); refresh(); } finally { setBusy(false); } };
  const authorize = async () => { setBusy(true); try { const r = await api.post<{ authorizeUrl: string }>('/freee/connection/authorize'); window.location.href = r.authorizeUrl; } catch (e) { toast(errMsg(e), 'err'); setBusy(false); } };
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const c = q.data;
  return (
    <div className="max-w-3xl space-y-4">
      <PageHead title="freee 連携の設定" />
      <Card title="連携の状態" actions={<Pill tone={ST[c.status][1]}>{ST[c.status][0]}</Pill>}>
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
          <dt className="text-gray-500">事業所</dt><dd>{c.companyName ?? '—'}{c.companyId && <span className="ml-2 text-xs text-gray-500">ID {c.companyId}</span>}</dd>
          <dt className="text-gray-500">許可した人</dt><dd>{c.authorizedFreeeUser ?? '—'}</dd>
          <dt className="text-gray-500">連携した日時</dt><dd>{jdatetime(c.connectedAt)}</dd>
          <dt className="text-gray-500">最後の確認</dt><dd>{jdatetime(c.lastCheckedAt)}</dd>
        </dl>
        {c.lastError && <div className="mt-3"><Alert tone="err">{c.lastError}</Alert></div>}
        <div className="mt-4 flex gap-2">
          {c.status !== 'CONNECTED' && <Button kind="freee" busy={busy} onClick={authorize}>{c.status === 'REAUTH_REQUIRED' ? 'freee と再連携する' : 'freee と連携する'}</Button>}
          {c.status !== 'DISCONNECTED' && <Button kind="danger" onClick={() => setDisc(true)}>連携を解除</Button>}
        </div>
        <p className="mt-3 text-xs text-gray-600">「連携する」を押すと freee の画面が開きます。freee にログインし、フジモト様の事業所を選んで許可してください。鍵は暗号化して保存し、画面・記録には出しません。</p>
      </Card>
      {c.status === 'COMPANY_REQUIRED' && (
        <Card title="事業所の選択">
          <Field label="使う事業所"><Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}><option value="">選んでください</option>{(companies.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Button kind="primary" className="mt-3" disabled={!companyId} busy={busy} onClick={() => patch({ companyId: Number(companyId) }, '事業所を選びました')}>この事業所を使う</Button>
        </Card>
      )}
      <Card title="登録のしかた">
        <div className="space-y-2 text-sm">
          {(['REVIEW', 'AUTO'] as const).map((m) => (
            <label key={m} className="flex items-start gap-2"><input type="radio" name="mode" checked={c.registrationMode === m} disabled={busy} onChange={() => patch({ registrationMode: m }, '登録のしかたを変えました')} />
              <span><b>{m === 'REVIEW' ? '確認してから登録（おすすめ）' : '自動で登録'}</b><br /><span className="text-gray-600">{m === 'REVIEW' ? 'メール送信のあと「freee 登録」の画面で内容を見て、まとめて登録します' : 'メール送信に成功したら、対応付けが済んでいればすぐ freee に登録します'}</span></span></label>
          ))}
        </div>
      </Card>
      <ConfirmDialog open={disc} onClose={() => setDisc(false)} title="freee 連携の解除" danger okLabel="解除する" message="SoilFlow に保存した freee の鍵を消します。freee 側の連携の解除は、freee の画面（アプリ連携）で行ってください。登録待ちの請求書は、再び連携するまで登録されません。"
        onOk={async () => { await api.del('/freee/connection'); toast('連携を解除しました'); refresh(); }} />
    </div>
  );
}
