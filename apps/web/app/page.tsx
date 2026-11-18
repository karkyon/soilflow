'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeOf, useMeQuery } from '@/lib/auth';

export default function Home() {
  const q = useMeQuery(); const router = useRouter();
  useEffect(() => {
    if (q.error || (q.data && (q.data.mustChangePassword || q.data.mfaRequired))) router.replace('/login/');
    else if (q.data) router.replace(homeOf(q.data.role));
  }, [q.data, q.error, router]);
  return <div className="p-10 text-center text-gray-500">読み込み中…</div>;
}
