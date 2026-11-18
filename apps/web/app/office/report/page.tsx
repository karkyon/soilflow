'use client';
/* SCR-31 受入日報（本社）。受付と同じ画面を5秒ごとに更新（FR-AGG-02、FR-RCV-17） */
import { DailyGrid } from '@/components/report/DailyGrid';

export default function OfficeReportPage() {
  return <div className="-m-6 h-[calc(100vh-52px)]"><DailyGrid office /></div>;
}
