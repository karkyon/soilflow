/* freee の鍵の暗号化（Cloud KMS、NFR-14）。ローカル・試験は AES-256-GCM */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../common/config';

export const KMS = Symbol('KMS');
export interface KmsAdapter {
  encrypt(plain: string): Promise<{ ciphertext: Buffer; keyVersion: string }>;
  decrypt(ciphertext: Buffer): Promise<string>;
}

export class LocalKms implements KmsAdapter {
  async encrypt(plain: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', config.tokenEncKey, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { ciphertext: Buffer.concat([iv, c.getAuthTag(), body]), keyVersion: 'local-1' };
  }
  async decrypt(buf: Buffer) {
    const d = createDecipheriv('aes-256-gcm', config.tokenEncKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  }
}

export class GcpKms implements KmsAdapter {
  private client;
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { KeyManagementServiceClient } = require('@google-cloud/kms');
    this.client = new KeyManagementServiceClient();
  }
  async encrypt(plain: string) {
    const [r] = await this.client.encrypt({ name: config.kmsKeyName, plaintext: Buffer.from(plain, 'utf8') });
    return { ciphertext: Buffer.from(r.ciphertext as Uint8Array), keyVersion: String(r.name ?? config.kmsKeyName) };
  }
  async decrypt(ciphertext: Buffer) {
    const [r] = await this.client.decrypt({ name: config.kmsKeyName, ciphertext });
    return Buffer.from(r.plaintext as Uint8Array).toString('utf8');
  }
}
