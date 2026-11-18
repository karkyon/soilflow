'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client';

export interface Customer { id: string; name: string; kana: string; defaultBillingPartyId: string; sortOrder: number; active: boolean; version: number; note?: string | null }
export interface Site { id: string; customerId: string; name: string; kana: string; defaultBillingPartyId: string | null; active: boolean; version: number }
export interface Vehicle { id: string; customerId: string; vehicleNo: string; defaultVehicleClassId: string | null; active: boolean; version: number }
export interface Item { id: string; reportLabel: string; priceItemName: string; direction: 'RECEIVE' | 'DELIVER'; sortOrder: number; active: boolean; version: number; pricePerM3Ref?: number | null; smallVehicleFeeRef?: number; freeeAccountItemId?: number | null; freeeAccountItemName?: string | null; freeeTaxCode?: number | null; freeeTaxName?: string | null; freeeItemId?: number | null; freeeItemName?: string | null }
export interface VehicleClass { id: string; name: string; capacityM3: number; smallVehicle: boolean; sortOrder: number; active: boolean; version: number }
export interface BillingParty { id: string; name: string; kana: string; honorific: string; postalCode?: string | null; address?: string | null; mailTo?: string[]; mailCc?: string[]; closingDay?: number; paymentMonthOffset?: number; paymentDay?: number; freeePartnerId?: number | null; freeePartnerName?: string | null; freeeMappingStatus?: string; note?: string | null; active: boolean; version: number }
export interface MarkM { id: string; symbol: string; displayName: string; color: string; sortOrder: number; active: boolean; version: number; rules: { fromItemId: string; toItemId: string }[] }

export function useMaster<T>(kind: string, params?: Record<string, string | boolean | undefined>) {
  return useQuery({ queryKey: ['masters', kind, params ?? {}], queryFn: () => api.get<T[]>(`/masters/${kind}`, params), staleTime: 60000 });
}
