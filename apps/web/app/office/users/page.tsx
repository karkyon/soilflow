'use client';
/* SCR-60 利用者管理（FR-CMN-03）。仮のパスワードは追加・初期化のときに1度だけ表示 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, ErrorBox, errMsg, Field, Input, Loading, PageHead, Pill, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';
import { RequireRole } from '@/lib/auth';
import { jdatetime } from '@/lib/format';

interface User { id: string; loginId: string; name: string; role: string; email: string | null; mfaEnabled: boolean; pairedTerminalId: string | null; lockedUntil: string | null; mustChangePassword: boolean; active: boolean; version: number }
const ROLES: Record<string, string> = { RECEPTION: '受付', OFFICE: '本社', ADMIN: '管理者', SIGN_TERMINAL: 'サイン端末' };

export default function Page() { return <RequireRole roles={['ADMIN']}><Users /></RequireRole>; }

function Users() {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const [edit, setEdit] = useState<User | 'new' | null>(null); const [pw, setPw] = useState<{ name: string; pw: string } | null>(null);
  const terminals = (q.data ?? []).filter((u) => u.role === 'SIGN_TERMINAL' && u.active);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  return (
    <div className="space-y-4">
      <PageHead title="利用者管理" sub="受付の利用者には「対の端末」（伝票を送るサイン用タブレット）を設定します" actions={<Button kind="primary" onClick={() => setEdit('new')}>＋ 利用者を追加</Button>} />
      <Table head={<><Th>ログインID</Th><Th>名前</Th><Th>区分</Th><Th>メール</Th><Th>対の端末</Th><Th>状態</Th><Th className="w-56" /></>}>
        {q.data.map((u) => (
          <tr key={u.id} className={u.active ? '' : 'opacity-50'}>
            <Td className="font-mono">{u.loginId}</Td><Td>{u.name}</Td><Td>{ROLES[u.role]}{u.role === 'ADMIN' && u.mfaEnabled && <span className="ml-1 text-xs text-gray-500">2段階</span>}</Td><Td className="text-xs">{u.email ?? '—'}</Td>
            <Td className="text-xs">{q.data.find((x) => x.id === u.pairedTerminalId)?.name ?? '—'}</Td>
            <Td>{!u.active ? <Pill>無効</Pill> : u.lockedUntil && u.lockedUntil > new Date().toISOString() ? <Pill tone="err">ロック中（{jdatetime(u.lockedUntil).slice(11)}まで）</Pill> : u.mustChangePassword ? <Pill tone="warn">初回の変更待ち</Pill> : <Pill tone="ok">有効</Pill>}</Td>
            <Td><div className="flex gap-1"><Button size="sm" onClick={() => setEdit(u)}>直す</Button>
              <Button size="sm" onClick={async () => { try { const r = await api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`); setPw({ name: u.name, pw: r.temporaryPassword }); refresh(); } catch (e) { toast(errMsg(e), 'err'); } }}>パスワード初期化</Button></div></Td>
          </tr>
        ))}
      </Table>
      <UserDialog rec={edit} terminals={terminals} onClose={() => setEdit(null)} onSaved={(name, p) => { refresh(); if (p) setPw({ name, pw: p }); }} />
      <Dialog open={!!pw} onClose={() => setPw(null)} title="仮のパスワード" width={420} footer={<Button kind="primary" onClick={() => setPw(null)}>メモしました</Button>}>
        <p className="text-sm">{pw?.name} さんの仮のパスワードです。この画面を閉じると二度と表示できません。次のログインで変更してもらいます。</p>
        <div className="mt-3 rounded-lg bg-cream p-4 text-center font-mono text-2xl tracking-wider select-all">{pw?.pw}</div>
      </Dialog>
    </div>
  );
}

function UserDialog({ rec, terminals, onClose, onSaved }: { rec: User | 'new' | null; terminals: User[]; onClose: () => void; onSaved: (name: string, pw?: string) => void }) {
  const toast = useToast();
  const [v, setV] = useState({ loginId: '', name: '', role: 'RECEPTION', email: '', mfaEnabled: false, pairedTerminalId: '', active: true });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!rec) return; setErr(null); setV(rec === 'new' ? { loginId: '', name: '', role: 'RECEPTION', email: '', mfaEnabled: false, pairedTerminalId: terminals[0]?.id ?? '', active: true } : { loginId: rec.loginId, name: rec.name, role: rec.role, email: rec.email ?? '', mfaEnabled: rec.mfaEnabled, pairedTerminalId: rec.pairedTerminalId ?? '', active: rec.active }); }, [rec, terminals]);
  if (!rec) return null;
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { loginId: v.loginId.trim(), name: v.name.trim(), role: v.role, email: v.email.trim() || null, mfaEnabled: v.role === 'ADMIN' ? v.mfaEnabled : false, pairedTerminalId: v.role === 'SIGN_TERMINAL' ? null : v.pairedTerminalId || null, active: v.active };
    try {
      if (rec === 'new') { const r = await api.post<{ temporaryPassword: string }>('/users', body); onSaved(body.name, r.temporaryPassword); }
      else { await api.patch(`/users/${rec.id}`, { ...body, version: rec.version }); onSaved(body.name); toast('直しました'); }
      onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={rec === 'new' ? '利用者の追加' : '利用者の修正'} width={520} footer={<><Button onClick={onClose}>やめる</Button><Button kind="primary" busy={busy} onClick={save}>{rec === 'new' ? '追加する' : '直す'}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="ログインID" required hint="英小文字・数字・._-"><Input value={v.loginId} onChange={(e) => setV({ ...v, loginId: e.target.value.toLowerCase() })} /></Field>
        <Field label="名前" required><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field label="区分" required><Select value={v.role} onChange={(e) => setV({ ...v, role: e.target.value, mfaEnabled: e.target.value === 'ADMIN' })}>{Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label="メール" hint={v.role === 'ADMIN' ? '2段階の確認のコードを送ります' : undefined}><Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        {v.role !== 'SIGN_TERMINAL' && <Field label="対の端末（サイン用タブレット）"><Select value={v.pairedTerminalId} onChange={(e) => setV({ ...v, pairedTerminalId: e.target.value })}><option value="">なし</option>{terminals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>}
        {v.role === 'ADMIN' && <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={v.mfaEnabled} onChange={(e) => setV({ ...v, mfaEnabled: e.target.checked })} /> 2段階の確認を使う</label>}
        {rec !== 'new' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> 有効</label>}
      </div>
      {v.role === 'SIGN_TERMINAL' && <div className="mt-3"><Alert tone="info">サイン端末はタブレットでログインしたまま使います（12時間で自動ログアウト）。</Alert></div>}
      {err && <p className="mt-3 text-sm font-bold text-err" role="alert">{err}</p>}
    </Dialog>
  );
}
