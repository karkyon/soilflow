import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { config } from './config';

export type Tx = Prisma.TransactionClient;
export { Prisma };

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10) }) });
  }
  async onModuleDestroy() { await this.$disconnect(); }

  /** 業務の変更と操作履歴を1つのトランザクションで（14 4章 No.4） */
  tx<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> {
    return this.$transaction(fn, { timeout: opts?.timeout ?? 30000, maxWait: 10000 });
  }
}
