'use client';
/* CSV の一括登録（FR-MST-10）。docs/reference/templates のひな形（UTF-8・Shift_JIS）。まず確認だけ、問題なければ登録 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, Field, errMsg, PageHead, Select, Table, Td, Th, useToast } from '@/components/ui';
import { api } from '@/lib/api/client';

const KINDS = [['billingParties', '請求先', '名称,読みがな,敬称,郵便番号,住所,送付先メール,送付先メール（CC）,締め日,支払月,支払日'], ['customers', '客先', '会社名,読みがな,既定の請求先,備考'], ['sites', '現場', '会社名,現場名,読みがな,既定の請求先'], ['vehicles', '車番', '会社名,車番,よく使う車格']] as const;
interface Result { created: number; updated: number; errors: { line: number; message: string }[] }

export default function ImportPage() {
  const toast = useToast(); const qc = useQueryClient();
  const [kind, setKind] = useState<string>('billingParties'); const [file, setFile] = useState<File | null>(null); const [res, setRes] = useState<(Result & { dry: boolean }) | null>(null); const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    if (!file) return; setBusy(true);
    try {
      const fd = new FormData(); fd.append('kind', kind); fd.append('dryRun', String(dryRun)); fd.append('file', file);
      const r = await api.post<Result>('/masters/import', fd); setRes({ ...r, dry: dryRun });
      if (!dryRun) { toast(`登録しました（追加 ${r.created}・変更 ${r.updated}）`); qc.invalidateQueries({ queryKey: ['masters'] }); }
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="max-w-3xl space-y-4">
      <PageHead title="CSV の一括登録" sub="請求先 → 客先 → 現場 → 車番 の順に登録してください（後のものは前のものの名前を使います）" />
      <Card>
        <div className="grid grid-cols-2 gap-4">
          <Field label="登録するマスタ"><Select value={kind} onChange={(e) => { setKind(e.target.value); setRes(null); }}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="CSV ファイル" hint="Excel で保存した CSV（Shift_JIS）もそのまま使えます"><input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); }} /></Field>
        </div>
        <p className="mt-3 text-xs text-gray-600">見出しの行：{KINDS.find((k) => k[0] === kind)![2]}　（同じ名前があれば変更、なければ追加）</p>
        <div className="mt-4 flex gap-2"><Button busy={busy} disabled={!file} onClick={() => run(true)}>確認だけする</Button><Button kind="primary" busy={busy} disabled={!file || !res?.dry || res.errors.length > 0} onClick={() => run(false)}>登録する</Button></div>
      </Card>
      {res && <Card title={res.dry ? '確認の結果（まだ登録していません）' : '登録の結果'}>
        <p className="mb-3 text-sm">追加 <b className="num">{res.created}</b>　変更 <b className="num">{res.updated}</b>　エラー <b className="num">{res.errors.length}</b></p>
        {res.errors.length > 0 ? <><Alert tone="err">エラーの行を直してから、もう一度「確認だけする」を押してください。</Alert>
          <Table className="mt-3" head={<><Th className="w-20">行</Th><Th>内容</Th></>}>{res.errors.map((e) => <tr key={e.line}><Td className="num">{e.line}</Td><Td>{e.message}</Td></tr>)}</Table></> : res.dry && <Alert tone="ok">問題ありません。「登録する」を押してください。</Alert>}
      </Card>}
    </div>
  );
}
