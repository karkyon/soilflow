'use client';
import { OfficeShell } from '@/components/Shell';
import { RequireRole } from '@/lib/auth';

export default function OfficeLayout({ children }: { children: React.ReactNode }) {
  return <RequireRole roles={['OFFICE', 'ADMIN']}><OfficeShell>{children}</OfficeShell></RequireRole>;
}
