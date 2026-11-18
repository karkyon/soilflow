'use client';
/* SCR-20 サイン待機・SCR-21 伝票の表示・サイン・SCR-22 サイン完了（FR-SGN、IF-05）。金額は出さない */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/Shell';
import { Button, errMsg } from '@/components/ui';
import { api } from '@/lib/api/client';
import { RequireRole, useMe } from '@/lib/auth';
import { jdate, jstNow } from '@/lib/format';

interface TSlip { id: string; slipNo: string; slipDate: string; addresseeName: string; siteName: string | null; lines: { lineNo: number; itemLabel: string; tripCount: number; vehicleNos: string }[]; status: string }

export default function TerminalPage() {
  return <RequireRole roles={['SIGN_TERMINAL']}><div className="flex h-screen flex-col"><TopBar app="サイン用タブレット" /><Terminal /></div></RequireRole>;
}

function Terminal() {
  const me = useMe();
  const [done, setDone] = useState<TSlip | null>(null);
  const q = useQuery({ queryKey: ['terminal'], queryFn: () => api.get<{ slip: TSlip | null }>('/terminal/current-slip'), refetchInterval: done ? false : 2000, refetchIntervalInBackground: true });
  // 戻る・再読み込みでサインが消えないよう、ほかの画面へは移れない（09 8章）
  useEffect(() => {
    history.pushState(null, '', location.href);
    const p = () => history.pushState(null, '', location.href);
    window.addEventListener('popstate', p);
    return () => window.removeEventListener('popstate', p);
  }, []);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(null), 6000); return () => clearTimeout(t); }, [done]);

  if (done) return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-cream p-10 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-ok text-5xl text-white">✓</div>
      <h1 className="text-4xl font-bold text-navy">ありがとうございました</h1>
      <p className="text-xl">控えは受付でお渡しします。</p>
      <Button size="lg" onClick={() => setDone(null)}>待機画面へ</Button>
    </div>
  );
  const slip = q.data?.slip;
  if (!slip) return <Waiting name={me.name} />;
  return <SignView key={slip.id} slip={slip} onDone={() => setDone(slip)} />;
}

function Waiting({ name }: { name: string }) {
  const [t, setT] = useState(jstNow().time);
  useEffect(() => { const i = setInterval(() => setT(jstNow().time), 10000); return () => clearInterval(i); }, []);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-navy text-white">
      <div className="text-6xl font-bold num">{t}</div>
      <h1 className="text-3xl font-bold">お待ちください</h1>
      <p className="text-lg opacity-80">伝票が届くと自動で表示されます</p>
      <p className="mt-6 text-sm opacity-60">{name}</p>
    </div>
  );
}

function SignView({ slip, onDone }: { slip: TSlip; onDone: () => void }) {
  const cv = useRef<HTMLCanvasElement>(null); const drawing = useRef(false); const last = useRef<{ x: number; y: number } | null>(null);
  const [strokes, setStrokes] = useState(0); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const total = slip.lines.reduce((a, l) => a + l.tripCount, 0);
  const pos = (e: React.PointerEvent) => { const c = cv.current!; const r = c.getBoundingClientRect(); return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height }; };
  const clear = useCallback(() => { const c = cv.current!; const g = c.getContext('2d')!; g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); setStrokes(0); }, []);
  useEffect(() => { clear(); }, [clear]);
  const down = (e: React.PointerEvent) => { e.preventDefault(); cv.current!.setPointerCapture(e.pointerId); drawing.current = true; last.current = pos(e); setStrokes((s) => s + 1); };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const g = cv.current!.getContext('2d')!; const p = pos(e);
    g.strokeStyle = '#111'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(last.current!.x, last.current!.y); g.lineTo(p.x, p.y); g.stroke(); last.current = p;
  };
  const up = () => { drawing.current = false; last.current = null; };
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const png = cv.current!.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      await api.post(`/terminal/slips/${slip.id}/sign`, { signaturePng: png, strokeCount: strokes });
      onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto bg-cream p-6 text-[18px]">
      <div className="rounded-xl border-2 border-navy bg-white p-6">
        <div className="flex items-baseline justify-between"><h1 className="text-2xl font-bold text-navy">納品伝票（受入）</h1><span>No. {slip.slipNo}　{jdate(slip.slipDate)}</span></div>
        <div className="mt-3 text-3xl font-bold">{slip.addresseeName} 様</div>
        <div className="text-xl">現場：{slip.siteName ?? '—'}</div>
        <table className="mt-4 w-full text-[20px]">
          <thead><tr className="border-b-2 border-navy text-left"><th className="py-2">品名</th><th className="w-24 text-center">台数</th><th>車番</th></tr></thead>
          <tbody>{slip.lines.map((l) => <tr key={l.lineNo} className="border-b border-line"><td className="py-2">{l.itemLabel}</td><td className="text-center font-bold num">{l.tripCount}</td><td className="text-base">{l.vehicleNos}</td></tr>)}
            <tr><td className="py-2 font-bold">合計</td><td className="text-center text-2xl font-bold num">{total}</td><td /></tr></tbody>
        </table>
      </div>
      <div className="rounded-xl border-2 border-gold bg-white p-4">
        <div className="mb-2 flex items-center justify-between"><b className="text-xl text-navy">受領サイン</b><span className="text-base text-gray-600">枠の中に指またはペンでサインしてください</span></div>
        <canvas ref={cv} width={1200} height={400} className="h-[260px] w-full touch-none rounded-lg border-2 border-dashed border-line bg-white" aria-label="サインの枠"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
        {err && <p className="mt-2 font-bold text-err" role="alert">{err}</p>}
        <div className="mt-4 flex gap-4">
          <Button size="lg" className="flex-1" onClick={clear}>書き直す</Button>
          <Button size="lg" kind="primary" className="flex-[2]" disabled={!strokes} busy={busy} onClick={submit}>確定する</Button>
        </div>
      </div>
    </div>
  );
}
