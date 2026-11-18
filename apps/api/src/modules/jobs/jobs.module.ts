/* ジョブ（04 3.4）。jobs テーブルに入れ、SELECT … FOR UPDATE SKIP LOCKED で1件ずつ取り出す。
 * 利用者の操作で起きるジョブは API がその場で1回目を実行し、失敗したときだけ Cloud Scheduler（毎分）が再試行する */
import { Controller, Global, HttpCode, Injectable, Logger, Module, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { hostname } from 'node:os';
import { Public } from '../../common/actor';
import { config } from '../../common/config';
import { jst, now } from '../../common/dates';
import { AppError } from '../../common/errors';
import { PrismaService, Prisma, Tx } from '../../common/prisma.service';

export type JobKind = 'PDF_SLIP' | 'PDF_INVOICE' | 'MAIL_SEND' | 'FREEE_REGISTER' | 'FREEE_DELETE' | 'FREEE_TOKEN_REFRESH' | 'CLEANUP';
/** 一時的な失敗。retryAfterMs を指定すると、その時間をあけて再試行する（freee の 429 など） */
export class RetryLater extends Error { constructor(message: string, readonly retryAfterMs?: number) { super(message); } }
/** 再試行しても直らない失敗（ジョブを FAILED にする） */
export class GiveUp extends Error {}
export type JobHandler = (payload: Record<string, unknown>, ctx: { attempt: number; final: boolean }) => Promise<void>;

/** 再試行の間隔（分）。04 3.4 */
const BACKOFF_MIN: Record<JobKind, number[]> = {
  PDF_SLIP: [1, 1, 1, 1, 1], PDF_INVOICE: [1, 1, 1, 1, 1], MAIL_SEND: [1, 5, 15, 60],
  FREEE_REGISTER: [1, 5, 15, 60, 180], FREEE_DELETE: [1, 5, 15, 60, 180], FREEE_TOKEN_REFRESH: [1, 5, 15], CLEANUP: [60],
};
interface JobRow { id: bigint; kind: JobKind; payload: Record<string, unknown>; attempts: number; max_attempts: number }

@Injectable()
export class JobsService {
  private readonly log = new Logger('Jobs');
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly worker = `${hostname()}:${process.pid}`;
  constructor(private readonly prisma: PrismaService) {}

  register(kind: JobKind, h: JobHandler) { this.handlers.set(kind, h); }

  /** ジョブを予約する。dedupeKey が予約中・実行中なら何もしない（ux_jobs_dedupe） */
  async enqueue(db: Tx | PrismaService, kind: JobKind, payload: Record<string, unknown>, o: { dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {}) {
    const rows = await db.$queryRaw<{ id: bigint }[]>`
      INSERT INTO jobs (kind, payload, dedupe_key, run_after, max_attempts)
      VALUES (${kind}, ${JSON.stringify(payload)}::jsonb, ${o.dedupeKey ?? null}, ${o.runAfter ?? now()}, ${o.maxAttempts ?? BACKOFF_MIN[kind].length + 1})
      ON CONFLICT (dedupe_key) WHERE status IN ('QUEUED','RUNNING') AND dedupe_key IS NOT NULL DO NOTHING
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  /** その場で1回目を実行する（予約したジョブを取り出して実行） */
  async runNow(id: bigint | null) {
    if (id === null) return;
    const job = await this.claim(id);
    if (job) await this.execute(job);
  }

  private async claim(id?: bigint): Promise<JobRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = id !== undefined
        ? await tx.$queryRaw<JobRow[]>`SELECT id, kind, payload, attempts, max_attempts FROM jobs WHERE id = ${id} AND status = 'QUEUED' FOR UPDATE SKIP LOCKED`
        : await tx.$queryRaw<JobRow[]>`SELECT id, kind, payload, attempts, max_attempts FROM jobs WHERE status = 'QUEUED' AND run_after <= ${now()} ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const j = rows[0];
      if (!j) return null;
      await tx.$executeRaw`UPDATE jobs SET status = 'RUNNING', locked_at = ${now()}, locked_by = ${this.worker}, attempts = attempts + 1 WHERE id = ${j.id}`;
      return { ...j, attempts: j.attempts + 1 };
    });
  }

  private async execute(j: JobRow): Promise<boolean> {
    const h = this.handlers.get(j.kind);
    const final = j.attempts >= j.max_attempts;
    try {
      if (!h) throw new GiveUp(`処理が登録されていないジョブ ${j.kind}`);
      await h(j.payload, { attempt: j.attempts, final });
      await this.prisma.$executeRaw`UPDATE jobs SET status = 'DONE', finished_at = ${now()}, last_error = NULL WHERE id = ${j.id}`;
      return true;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 1000);
      if (!(e instanceof GiveUp) && !final) {
        const wait = e instanceof RetryLater && e.retryAfterMs ? e.retryAfterMs : (BACKOFF_MIN[j.kind][j.attempts - 1] ?? 60) * 60000;
        await this.prisma.$executeRaw`UPDATE jobs SET status = 'QUEUED', run_after = ${new Date(now().getTime() + wait)}, last_error = ${msg}, locked_at = NULL, locked_by = NULL WHERE id = ${j.id}`;
        return false;
      }
      this.log.error(JSON.stringify({ severity: 'ERROR', alert: 'JOB_FAILED', jobId: Number(j.id), kind: j.kind, error: msg }));
      await this.prisma.$executeRaw`UPDATE jobs SET status = 'FAILED', finished_at = ${now()}, last_error = ${msg} WHERE id = ${j.id}`;
      return false;
    }
  }

  /** 毎分の実行（Cloud Scheduler）。毎日のジョブもここで予約する */
  async runDue(maxJobs = 50, budgetMs = 45000) {
    await this.scheduleDaily();
    // 止まったまま（10分以上 RUNNING）のジョブを戻す
    await this.prisma.$executeRaw`UPDATE jobs SET status = 'QUEUED', locked_at = NULL, locked_by = NULL WHERE status = 'RUNNING' AND locked_at < ${new Date(now().getTime() - 600000)}`;
    let done = 0, failed = 0; const start = Date.now();
    for (let i = 0; i < maxJobs && Date.now() - start < budgetMs; i++) {
      const j = await this.claim();
      if (!j) break;
      if (await this.execute(j)) done++; else failed++;
    }
    return { done, failed };
  }

  /** 毎日1回のジョブ（鍵の更新・掃除）。同じ日の分がすでにあれば予約しない */
  private async scheduleDaily() {
    const d = jst().date;
    const daily: [JobKind, boolean][] = [['FREEE_TOKEN_REFRESH', true], ['CLEANUP', jst().hour >= 2]];
    for (const [kind, due] of daily) {
      if (!due) continue;
      const key = `${kind}:${d}`;
      if (await this.prisma.job.count({ where: { dedupeKey: key } })) continue;
      await this.enqueue(this.prisma, kind, { date: d }, { dedupeKey: key });
    }
  }
}

/* ---------------------------------------------------------------- Cloud Scheduler からの呼び出し */
const oidc = new OAuth2Client();
@Controller('internal/jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}
  @Post('run') @Public() @HttpCode(200)
  async run(@Req() req: Request) {
    await verifySchedulerToken(req.header('authorization'));
    return this.jobs.runDue();
  }
}
/** Google が発行する OIDC トークン（送り先・発行者・サービスアカウント）を確かめる（08 2章） */
export async function verifySchedulerToken(auth: string | undefined) {
  if (!config.schedulerAudience) {
    if (config.isProd) throw new AppError('UNAUTHENTICATED');
    return; // ローカル・試験
  }
  const token = /^Bearer (.+)$/.exec(auth ?? '')?.[1];
  if (!token) throw new AppError('UNAUTHENTICATED');
  try {
    const t = await oidc.verifyIdToken({ idToken: token, audience: config.schedulerAudience });
    const p = t.getPayload();
    if (!p || !['https://accounts.google.com', 'accounts.google.com'].includes(p.iss)) throw new Error('iss');
    if (config.schedulerServiceAccount && p.email !== config.schedulerServiceAccount) throw new Error('email');
  } catch { throw new AppError('UNAUTHENTICATED'); }
}

@Global()
@Module({ providers: [JobsService], controllers: [JobsController], exports: [JobsService] })
export class JobsModule {}

export type { Prisma };
