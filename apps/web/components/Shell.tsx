'use client';
/* 上部バー（52px）・本社の左メニュー（200px）（05 1.1） */
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { api } from '@/lib/api/client';
import { useMe } from '@/lib/auth';
import { cx } from './ui';

const ROLE_JA: Record<string, string> = { RECEPTION: '受付', OFFICE: '本社', ADMIN: '管理者', SIGN_TERMINAL: 'サイン端末' };

export function useOnline() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(navigator.onLine);
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener('online', a); window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

export function TopBar({ app, nav }: { app: string; nav?: { href: string; label: string }[] }) {
  const me = useMe(); const online = useOnline(); const path = usePathname(); const router = useRouter(); const qc = useQueryClient();
  const logout = async () => { await api.post('/auth/logout').catch(() => undefined); qc.clear(); router.replace('/login/'); };
  return (
    <header className="no-print sticky top-0 z-40 flex h-[52px] items-center gap-4 bg-navy px-4 text-white">
      <Link href="/" className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-md bg-gold font-black">S</span><span className="font-bold">SoilFlow</span><span className="text-xs opacity-70">{app}</span></Link>
      <nav className="flex gap-1">
        {nav?.map((n) => <Link key={n.href} href={n.href} className={cx('rounded-md px-3 py-1.5 text-sm font-bold', path === n.href ? 'bg-white/15' : 'opacity-80 hover:opacity-100')}>{n.label}</Link>)}
      </nav>
      <div className="ml-auto flex items-center gap-3 text-sm">
        <span className={online ? 'text-green-300' : 'text-red-300'} role="status">● {online ? 'オンライン' : 'オフライン（記入できません）'}</span>
        <span>{me.name}</span><span className="rounded bg-white/15 px-2 py-0.5 text-xs">{ROLE_JA[me.role]}</span>
        <button onClick={logout} className="rounded-md border border-white/40 px-3 py-1 text-sm hover:bg-white/10">ログアウト</button>
      </div>
    </header>
  );
}

type NavItem = { href: string; label: string; admin?: boolean };
const OFFICE_NAV: { group: string; items: NavItem[] }[] = [
  { group: '業務', items: [{ href: '/office/', label: '状況' }, { href: '/office/report/', label: '受入日報' }, { href: '/office/slips/', label: '伝票' }, { href: '/office/aggregates/', label: '集計' }, { href: '/office/billing/', label: '請求' }, { href: '/office/cash/', label: '現金の領収書' }] },
  { group: 'freee 連携', items: [{ href: '/office/freee/', label: 'freee 登録' }, { href: '/office/freee/settings/', label: '連携の設定', admin: true }, { href: '/office/freee/partners/', label: '取引先の対応付け' }, { href: '/office/freee/items/', label: '品目の対応付け', admin: true }, { href: '/office/freee/logs/', label: '登録の履歴' }] },
  { group: 'マスタ', items: [
    { href: '/office/masters/?kind=customers', label: '客先' }, { href: '/office/masters/?kind=sites', label: '現場' }, { href: '/office/masters/?kind=billingParties', label: '請求先' },
    { href: '/office/masters/?kind=vehicles', label: '車番' }, { href: '/office/masters/?kind=items', label: '品目' }, { href: '/office/masters/?kind=vehicleClasses', label: '車格' },
    { href: '/office/price-tables/', label: '単価表' }, { href: '/office/masters/?kind=marks', label: '印' }, { href: '/office/import/', label: 'CSV の一括登録' }] },
  { group: '管理', items: [{ href: '/office/users/', label: '利用者', admin: true }, { href: '/office/audit/', label: '操作履歴' }, { href: '/office/settings/', label: 'システム設定' }] },
];

export function OfficeShell({ children }: { children: ReactNode }) {
  const me = useMe(); const path = usePathname();
  const [cur, setCur] = useState('');
  useEffect(() => { setCur(window.location.pathname + window.location.search); }, [path]);
  return (
    <div className="min-h-screen">
      <TopBar app="本社" />
      <div className="flex">
        <aside className="no-print sticky top-[52px] h-[calc(100vh-52px)] w-[200px] shrink-0 overflow-y-auto border-r border-line bg-white py-3">
          {OFFICE_NAV.map((g) => (
            <div key={g.group} className="mb-3">
              <div className="px-4 pb-1 text-xs font-bold text-gray-500">{g.group}</div>
              {g.items.filter((i) => !i.admin || me.role === 'ADMIN').map((i) => {
                const active = i.href.includes('?') ? cur === i.href : path === i.href;
                return <Link key={i.href} href={i.href} onClick={() => setCur(i.href)} className={cx('block border-l-4 px-4 py-1.5 text-sm', active ? 'border-gold bg-gold-pale font-bold text-navy' : 'border-transparent text-gray-700 hover:bg-cream')}>{i.label}</Link>;
              })}
            </div>
          ))}
        </aside>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
