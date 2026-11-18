/* ファイルの保存（Cloud Storage）。ローカル・試験はディスクに保存し、署名付き URL は API が発行する */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../common/config';
import { now } from '../common/dates';

export const STORAGE = Symbol('STORAGE');
export interface SignedFile { url: string; fileName: string; expiresAt: string }
export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** 5分で失効する URL（08 1章） */
  signedUrl(key: string, fileName: string, contentType: string): Promise<SignedFile>;
}

const TTL_MS = 5 * 60 * 1000;
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class LocalStorage implements StorageAdapter {
  private readonly root = resolve(config.storageDir);
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('不正なキー');
    return p;
  }
  async put(key: string, data: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); }
  get(key: string) { return readFile(this.path(key)); }
  async exists(key: string) { try { await stat(this.path(key)); return true; } catch { return false; } }
  async signedUrl(key: string, fileName: string, contentType: string): Promise<SignedFile> {
    const exp = now().getTime() + TTL_MS;
    const body = b64u(JSON.stringify({ k: key, f: fileName, t: contentType, e: exp }));
    const sig = b64u(createHmac('sha256', config.sessionSecret).update(`file:${body}`).digest());
    return { url: `${config.publicBaseUrl}/api/v1/files/${body}.${sig}`, fileName, expiresAt: new Date(exp).toISOString() };
  }
  /** /files/:token の確認 */
  static verify(token: string): { key: string; fileName: string; contentType: string } | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const want = createHmac('sha256', config.sessionSecret).update(`file:${body}`).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const x = JSON.parse(Buffer.from(body, 'base64url').toString()) as { k: string; f: string; t: string; e: number };
    if (x.e < now().getTime()) return null;
    return { key: x.k, fileName: x.f, contentType: x.t };
  }
}

export class GcsStorage implements StorageAdapter {
  private bucket;
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Storage } = require('@google-cloud/storage');
    this.bucket = new Storage().bucket(config.gcsBucket);
  }
  async put(key: string, data: Buffer, contentType: string) { await this.bucket.file(key).save(data, { contentType, resumable: false }); }
  async get(key: string) { const [b] = await this.bucket.file(key).download(); return b as Buffer; }
  async exists(key: string) { const [e] = await this.bucket.file(key).exists(); return e as boolean; }
  async signedUrl(key: string, fileName: string, contentType: string): Promise<SignedFile> {
    const expires = now().getTime() + TTL_MS;
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: 'v4', action: 'read', expires,
      responseDisposition: `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`, responseType: contentType,
    });
    return { url, fileName, expiresAt: new Date(expires).toISOString() };
  }
}
