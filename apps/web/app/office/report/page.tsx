'use client';
/* SCR-31 受入日報（本社）。受付と同じ画面を5秒ごとに更新（FR-AGG-02、FR-RCV-17）。?date= でその日を開く（集計からたどる、FR-AGG-04） */
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DailyGrid } from '@/components/report/DailyGrid';
import { Loading } from '@/components/ui';

function Report() {
  const d = useSearchParams().get('date');
  return <DailyGrid office key={d ?? ''} initialDate={d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined} />;
}
export default function OfficeReportPage() {
  return <div className="-m-6 h-[calc(100vh-52px)]"><Suspense fallback={<Loading />}><Report /></Suspense></div>;
}
