'use client';
/* SCR-01 ログイン（FR-CMN-01・02、NFR-12）。管理者は確認コード、初回はパスワードの変更 */
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { Button, errMsg, Field, Input } from '@/components/ui';
import { api, setCsrf } from '@/lib/api/client';
import { homeOf, Me, useMeQuery } from '@/lib/auth';

type Step = 'login' | 'mfa' | 'password';

export default function LoginPage() {
  const router = useRouter(); const qc = useQueryClient(); const meQ = useMeQuery();
  const [step, setStep] = useState<Step>('login');
  const [loginId, setLoginId] = useState(''); const [password, setPassword] = useState('');
  const [code, setCode] = useState(''); const [next, setNext] = useState(''); const [next2, setNext2] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  const proceed = (m: Me) => {
    setCsrf(m.csrfToken); qc.setQueryData(['me'], m);
    if (m.mfaRequired) setStep('mfa');
    else if (m.mustChangePassword) { setStep('password'); }
    else router.replace(homeOf(m.role));
  };
  useEffect(() => { if (meQ.data) proceed(meQ.data); }, [meQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await fn(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  const doLogin = run(async () => { const r = await api.post<{ mfaRequired: boolean; me: Me }>('/auth/login', { loginId: loginId.trim(), password }); setPassword(''); proceed(r.me); });
  const doMfa = run(async () => { const m = await api.post<Me>('/auth/mfa', { code }); proceed({ ...m, mfaRequired: false }); });
  const doPassword = run(async () => {
    if (next.length < 12) throw new Error('パスワードは12文字以上にしてください');
    if (next !== next2) throw new Error('確認のパスワードが一致しません');
    await api.post('/auth/password', { current: password, next });
    const m = await api.get<Me>('/auth/me'); proceed(m);
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy p-6">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold text-xl font-black text-white">S</span>
          <div><div className="text-lg font-bold text-navy">SoilFlow</div><div className="text-xs text-gray-500">受入・請求管理　株式会社フジモト 下足守事業所</div></div></div>
        {step === 'login' && (
          <form onSubmit={doLogin} className="space-y-4">
            <Field label="ログインID"><Input autoComplete="username" value={loginId} onChange={(e) => setLoginId(e.target.value)} required maxLength={40} autoFocus /></Field>
            <Field label="パスワード"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            {err && <p className="text-sm font-bold text-err" role="alert">{err}</p>}
            <Button type="submit" kind="primary" className="w-full" busy={busy}>ログイン</Button>
          </form>
        )}
        {step === 'mfa' && (
          <form onSubmit={doMfa} className="space-y-4">
            <p className="text-sm">メールで届いた6桁の確認コードを入れてください（10分間有効）。</p>
            <Field label="確認コード"><Input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus className="text-center text-lg tracking-[0.4em]" /></Field>
            {err && <p className="text-sm font-bold text-err" role="alert">{err}</p>}
            <Button type="submit" kind="primary" className="w-full" busy={busy} disabled={code.length !== 6}>確認する</Button>
            <Button kind="ghost" className="w-full" onClick={() => { setStep('login'); setCode(''); }}>ログインからやり直す</Button>
          </form>
        )}
        {step === 'password' && (
          <form onSubmit={doPassword} className="space-y-4">
            <p className="text-sm">はじめてのログインです。新しいパスワードを決めてください（12文字以上）。</p>
            <Field label="今のパスワード（仮のパスワード）"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            <Field label="新しいパスワード" hint="12文字以上。よく使われるもの・ログインIDを含むものは使えません"><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
            <Field label="新しいパスワード（確認）"><Input type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} required /></Field>
            {err && <p className="text-sm font-bold text-err" role="alert">{err}</p>}
            <Button type="submit" kind="primary" className="w-full" busy={busy}>変更してはじめる</Button>
          </form>
        )}
      </div>
    </div>
  );
}
