/* メール送信（IF-02、09 5章）。SendGrid Web API v3。ローカル・試験はにせもの（送信箱に貯める） */
import { createPublicKey, verify } from 'node:crypto';
import { config } from '../common/config';

export const MAIL = Symbol('MAIL');
export interface OutgoingMail {
  from: string; fromName?: string | null; replyTo?: string | null;
  to: string[]; cc?: string[]; subject: string; text: string;
  attachments?: { filename: string; content: Buffer; type: string }[];
  customArgs?: Record<string, string>;
}
/** status: 応答の HTTP（0＝通信エラー）。retryable：5xx・通信エラー */
export class MailError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) { super(message); }
}
export interface MailAdapter {
  send(m: OutgoingMail): Promise<{ messageId: string | null }>;
  /** webhook の署名の確認（SendGrid Event Webhook の ECDSA） */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
}

export class FakeMail implements MailAdapter {
  readonly outbox: (OutgoingMail & { messageId: string })[] = [];
  /** 次の送信を失敗させる（試験・デモ用） */
  failNext: { status: number; message: string } | null = null;
  async send(m: OutgoingMail) {
    if (this.failNext) {
      const f = this.failNext; this.failNext = null;
      throw new MailError(f.message, f.status, f.status === 0 || f.status >= 500);
    }
    const messageId = `fake-${this.outbox.length + 1}`;
    this.outbox.push({ ...m, messageId });
    if (!config.isTest) console.log(`[FakeMail] to=${m.to.join(',')} subject=${m.subject}`);
    return { messageId };
  }
  verifyWebhook() { return true; }
}

export class SendGridMail implements MailAdapter {
  async send(m: OutgoingMail) {
    const to = config.mailRedirectTo ? [config.mailRedirectTo] : m.to;
    const cc = config.mailRedirectTo ? [] : (m.cc ?? []).filter((c) => !to.includes(c));
    const body = {
      personalizations: [{ to: to.map((email) => ({ email })), ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}) }],
      from: { email: m.from, ...(m.fromName ? { name: m.fromName } : {}) },
      ...(m.replyTo ? { reply_to: { email: m.replyTo } } : {}),
      subject: m.subject,
      content: [{ type: 'text/plain', value: m.text }],
      ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ content: a.content.toString('base64'), filename: a.filename, type: a.type, disposition: 'attachment' })) } : {}),
      ...(m.customArgs ? { custom_args: m.customArgs } : {}),
    };
    let res: Response;
    try {
      res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST', headers: { Authorization: `Bearer ${config.sendgridApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new MailError(`メールサービスに接続できません（${(e as Error).message}）`, 0, true);
    }
    if (res.status === 202 || res.ok) return { messageId: res.headers.get('x-message-id') };
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = (JSON.parse(text).errors ?? []).map((x: { message: string }) => x.message).join(' / ') || text; } catch { /* そのまま */ }
    throw new MailError(`メールサービスの応答 ${res.status}：${msg.slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
  }
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const pk = config.sendgridWebhookPublicKey;
    if (!pk) return !config.isProd;
    const sig = String(headers['x-twilio-email-event-webhook-signature'] ?? '');
    const ts = String(headers['x-twilio-email-event-webhook-timestamp'] ?? '');
    if (!sig || !ts) return false;
    try {
      const key = createPublicKey({ key: Buffer.from(pk, 'base64'), format: 'der', type: 'spki' });
      return verify('sha256', Buffer.concat([Buffer.from(ts, 'utf8'), rawBody]), { key, dsaEncoding: 'der' }, Buffer.from(sig, 'base64'));
    } catch { return false; }
  }
}
