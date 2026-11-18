'use client';
/* ログイン中の利用者（/auth/me）と区分による画面の出し分け（守りの正本はサーバー、04 4章） */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, ReactNode, useContext, useEffect } from 'react';
import { api, ApiError, Role, S, setCsrf } from './api/client';

export type Me = S['Me'] & { mfaRequired?: boolean };
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;
export const isOffice = (r?: string) => r === 'OFFICE' || r === 'ADMIN';
export const homeOf = (r: Role) => (r === 'RECEPTION' ? '/reception/' : r === 'SIGN_TERMINAL' ? '/terminal/' : '/office/');

export function useMeQuery() {
  return useQuery({
    queryKey: ['me'], retry: false, staleTime: 60000,
    queryFn: async () => { const m = await api.get<Me>('/auth/me'); setCsrf(m.csrfToken); return m; },
  });
}

/** 許された区分でなければログイン画面・自分の画面へ */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const q = useMeQuery(); const router = useRouter(); const qc = useQueryClient();
  useEffect(() => {
    const h = () => { qc.removeQueries({ queryKey: ['me'] }); router.replace('/login/'); };
    window.addEventListener('sf:unauthenticated', h);
    return () => window.removeEventListener('sf:unauthenticated', h);
  }, [qc, router]);
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) router.replace('/login/');
    const m = q.data;
    if (m && (m.mustChangePassword || m.mfaRequired)) router.replace('/login/');
    else if (m && !roles.includes(m.role)) router.replace(homeOf(m.role));
  }, [q.data, q.error, roles, router]);
  if (!q.data || !roles.includes(q.data.role) || q.data.mustChangePassword || q.data.mfaRequired) return <div className="p-10 text-center text-gray-500">読み込み中…</div>;
  return <MeCtx.Provider value={q.data}>{children}</MeCtx.Provider>;
}
