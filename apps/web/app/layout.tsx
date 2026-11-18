import type { Metadata } from 'next';
import { Providers } from '@/components/Providers';
import './globals.css';

export const metadata: Metadata = { title: 'SoilFlow 受入・請求管理', robots: { index: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body><Providers>{children}</Providers></body></html>;
}
