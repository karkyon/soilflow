/* 入力の確認（zod。openapi.yaml と合わせる） */
import { z, ZodTypeAny } from 'zod';
import { isValidYmd } from './dates';

export const parse = <T extends ZodTypeAny>(schema: T, v: unknown): z.infer<T> => schema.parse(v ?? {});

export const zUuid = z.string().uuid();
export const zDate = z.string().refine(isValidYmd, '日付は YYYY-MM-DD');
export const zTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, '時刻は HH:MM');
export const zMonth = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, '月は YYYY-MM');
export const zVersion = z.object({ version: z.number().int() });
export const zReason = z.object({ version: z.number().int(), reason: z.string().trim().min(1, '理由を入れてください').max(500) });
/** クエリ文字列の真偽値 */
export const zBoolQ = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');
/** クエリ文字列の配列（a,b,c） */
export const zCsvQ = <T extends z.ZodType<unknown, string>>(item: T) =>
  z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)).pipe(z.array(item));
export const zIntQ = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number);
