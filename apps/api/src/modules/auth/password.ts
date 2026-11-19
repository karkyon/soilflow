/* パスワード（13 3章）。argon2id（メモリ 19MB・反復 2・並列 1） */
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { AppError } from '../../common/errors';
import { COMMON_PASSWORDS } from './common-passwords';

const OPTS = { type: argon2.argon2id as 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (p: string) => argon2.hash(p, OPTS);
export const verifyPassword = async (hash: string, p: string) => { try { return await argon2.verify(hash, p); } catch { return false; } };

/** よく使われるパスワード：上位1万件（common-passwords.ts）＋ 12文字以上で残りやすい形 */
const COMMON = new Set([...COMMON_PASSWORDS,
  '123456789012', '1234567890123', 'password1234', 'password12345', 'passwordpassword', 'qwertyuiop12', 'qwertyuiopas', '111111111111',
  '000000000000', 'abcdefghijkl', 'abc123abc123', 'iloveyou1234', 'administrator', 'adminadmin12', 'qwerty123456', '1q2w3e4r5t6y',
  '1qaz2wsx3edc', 'zaq12wsxcde3', 'aaaaaaaaaaaa', 'letmein12345', 'welcome12345', 'changeme1234', 'p@ssw0rd1234', 'passw0rd1234',
]);
/** よく使われる語そのもの・語に数字や記号を足しただけ・語の繰り返し（例：dragon123456、qwertyqwerty）か */
export function isCommonPassword(p: string) {
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(low)) return true;
  const m = /^(.*?[^0-9!@#$%^&*._\-+=?~]{1}.*?)([0-9!@#$%^&*._\-+=?~]*)$/.exec(low);
  const base = m ? m[1] : low;
  if (base.length >= 4 && COMMON.has(base)) return true;
  for (let n = 2; n <= 4; n++) if (low.length % n === 0) { const u = low.slice(0, low.length / n); if (u.repeat(n) === low && (COMMON.has(u) || u.length <= 3)) return true; }
  return false;
}
export function assertPasswordPolicy(p: string, loginId?: string) {
  if (p.length < 12) throw new AppError('VALIDATION_ERROR', 'パスワードは12文字以上にしてください');
  if (p.length > 200) throw new AppError('VALIDATION_ERROR', 'パスワードが長すぎます');
  if (isCommonPassword(p) || (loginId && p.toLowerCase().includes(loginId.toLowerCase()))) {
    throw new AppError('VALIDATION_ERROR', 'よく使われるパスワード・ログイン ID を含むパスワードは使えません');
  }
}
/** 仮のパスワード（読み間違えやすい文字を除く 16文字） */
export function temporaryPassword() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 16 }, () => cs[randomInt(cs.length)]).join('');
}
