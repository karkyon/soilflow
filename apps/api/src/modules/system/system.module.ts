/* 稼働確認・ローカルの署名付き URL・毎日の掃除（CLEANUP、07 9章） */
import { Controller, Get, Inject, Injectable, Module, OnModuleInit, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { STORAGE, StorageAdapter, LocalStorage } from '../../adapters/storage';
import { Public } from '../../common/actor';
import { now } from '../../common/dates';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { JobsService } from '../jobs/jobs.module';

@Injectable()
export class CleanupService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService, private readonly jobs: JobsService) {}
  onModuleInit() { this.jobs.register('CLEANUP', () => this.run()); }
  async run() {
    const t = now();
    const days = (n: number) => new Date(t.getTime() - n * 86400000);
    await this.prisma.$executeRaw`DELETE FROM sessions WHERE expires_at < ${t} OR revoked_at < ${days(1)}`;
    await this.prisma.$executeRaw`DELETE FROM mfa_codes WHERE expires_at < ${days(1)}`;
    await this.prisma.$executeRaw`DELETE FROM freee_oauth_states WHERE expires_at < ${days(1)}`;
    await this.prisma.$executeRaw`DELETE FROM jobs WHERE status IN ('DONE','FAILED') AND finished_at < ${days(90)}`;
    await this.prisma.$executeRaw`DELETE FROM freee_api_logs WHERE created_at < ${days(730)}`;
  }
}

@Controller()
export class SystemController {
  constructor(private readonly prisma: PrismaService, @Inject(STORAGE) private readonly storage: StorageAdapter) {}

  @Get('healthz') @Public()
  async health(@Res({ passthrough: true }) res: Response) {
    try { await this.prisma.$queryRaw`SELECT 1`; return { status: 'ok', time: now().toISOString() }; }
    catch { res.status(503); return { status: 'db-unavailable' }; }
  }

  /** ローカルの保存先の署名付き URL（Cloud Storage を使うときは使わない） */
  @Get('files/:token') @Public()
  async file(@Param('token') token: string, @Res() res: Response) {
    if (!(this.storage instanceof LocalStorage)) throw new AppError('NOT_FOUND');
    const f = LocalStorage.verify(token);
    if (!f) throw new AppError('NOT_FOUND', 'リンクの期限が切れました。画面から開き直してください');
    const data = await this.storage.get(f.key).catch(() => null);
    if (!data) throw new AppError('NOT_FOUND');
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(data);
  }
}

@Module({ providers: [CleanupService], controllers: [SystemController] })
export class SystemModule {}
