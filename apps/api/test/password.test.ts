/* パスワードの決まり（13 3章）。DB を使わない */
import { describe, expect, it } from 'vitest';
import { assertPasswordPolicy, isCommonPassword } from '../src/modules/auth/password';

describe('パスワードの決まり', () => {
  it.each(['dragon123456', 'qwertyqwerty', 'password!!!!1234', 'Sunshine2026!!', 'abcabcabcabc', 'aaaaaaaaaaaa', '1qaz2wsx3edc'])('よく使われる形は使えない：%s', (p) => {
    expect(isCommonPassword(p)).toBe(true);
    expect(() => assertPasswordPolicy(p)).toThrow(/よく使われる/);
  });
  it.each(['correct-horse-battery-staple', 'Tk7#mQ2v9Lp!', 'ilovesoilflow'])('使える：%s', (p) => { expect(() => assertPasswordPolicy(p, 'reception')).not.toThrow(); });
  it('12文字より短い・ログイン ID を含むものは使えない', () => {
    expect(() => assertPasswordPolicy('Tk7#mQ2v9Lp')).toThrow(/12文字以上/);
    expect(() => assertPasswordPolicy('reception-Tk7#mQ2v', 'reception')).toThrow(/ログイン ID/);
  });
});
