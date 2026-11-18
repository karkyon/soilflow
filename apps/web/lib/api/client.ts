/* API の呼び出し（08 API設計書）。Cookie __session ＋ 更新系は X-CSRF-Token */
import type { components } from './schema';

export type S = components['schemas'];
export type Role = S['Role'];
export const BASE = '/api/v1';

let csrfToken = '';
export const setCsrf = (t: string) => { csrfToken = t; };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly requestId?: string) { super(message); }
}

type Query = Record<string, string | number | boolean | string[] | null | undefined>;
function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function call<T>(method: string, path: string, body?: unknown, q?: Query): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs(q)}`, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'NETWORK', '通信できません。ネットワークを確かめてください');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new ApiError(res.status, data?.code ?? 'INTERNAL', data?.message ?? `エラー（${res.status}）`, data?.details, data?.requestId);
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('sf:unauthenticated'));
    throw e;
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string, q?: Query) => call<T>('GET', p, undefined, q), // eslint-disable-line @typescript-eslint/no-explicit-any
  post: <T = any>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}), // eslint-disable-line @typescript-eslint/no-explicit-any
  patch: <T = any>(p: string, b?: unknown) => call<T>('PATCH', p, b ?? {}), // eslint-disable-line @typescript-eslint/no-explicit-any
  put: <T = any>(p: string, b?: unknown) => call<T>('PUT', p, b), // eslint-disable-line @typescript-eslint/no-explicit-any
  del: <T = any>(p: string) => call<T>('DELETE', p), // eslint-disable-line @typescript-eslint/no-explicit-any
};

/** 署名付き URL のファイルを新しいタブで開く（印刷はブラウザの機能、09 6章） */
export async function openFile(p: string, q?: Query) {
  const w = window.open('', '_blank');
  try {
    const f = await api.get<{ url: string }>(p, q);
    if (w) w.location.href = f.url; else window.location.href = f.url;
  } catch (e) { w?.close(); throw e; }
}

export const uuid = () => crypto.randomUUID();
