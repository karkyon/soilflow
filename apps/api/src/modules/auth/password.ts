/* パスワード（13 3章）。argon2id（メモリ 19MB・反復 2・並列 1） */
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { AppError } from '../../common/errors';

const OPTS = { type: argon2.argon2id as 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (p: string) => argon2.hash(p, OPTS);
export const verifyPassword = async (hash: string, p: string) => { try { return await argon2.verify(hash, p); } catch { return false; } };

/** よく使われるパスワードの上位の一部（12文字以上で残りやすいもの）。本番前に上位1万件の一覧に差し替える */
const COMMON = new Set([
  '123456789012', '1234567890123', 'password1234', 'password12345', 'passwordpassword', 'qwertyuiop12', 'qwertyuiopas', '111111111111',
  '000000000000', 'abcdefghijkl', 'abc123abc123', 'iloveyou1234', 'administrator', 'adminadmin12', 'qwerty123456', '1q2w3e4r5t6y',
  '1qaz2wsx3edc', 'zaq12wsxcde3', 'aaaaaaaaaaaa', 'letmein12345', 'welcome12345', 'changeme1234', 'p@ssw0rd1234', 'passw0rd1234',
]);
export function assertPasswordPolicy(p: string, loginId?: string) {
  if (p.length < 12) throw new AppError('VALIDATION_ERROR', 'パスワードは12文字以上にしてください');
  if (p.length > 200) throw new AppError('VALIDATION_ERROR', 'パスワードが長すぎます');
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(p) || (loginId && low.includes(loginId.toLowerCase()))) {
    throw new AppError('VALIDATION_ERROR', 'よく使われるパスワード・ログイン ID を含むパスワードは使えません');
  }
}
/** 仮のパスワード（読み間違えやすい文字を除く 16文字） */
export function temporaryPassword() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 16 }, () => cs[randomInt(cs.length)]).join('');
}
