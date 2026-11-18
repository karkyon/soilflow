'use client';
import { TopBar } from '@/components/Shell';
import { RequireRole } from '@/lib/auth';

export default function ReceptionLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole roles={['RECEPTION', 'OFFICE', 'ADMIN']}>
      <div className="flex h-screen flex-col">
        <TopBar app="受付" nav={[{ href: '/reception/', label: '受入日報' }, { href: '/reception/slips/', label: '伝票一覧' }]} />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </RequireRole>
  );
}
