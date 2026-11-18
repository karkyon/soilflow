import 'dotenv/config';
import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { config } from './common/config';

/** 共通のヘッダ・リクエスト ID・本文の読み取り（08 1章、13 5章） */
export function configureApp(app: INestApplication) {
  const a = app as NestExpressApplication;
  a.set('trust proxy', true);
  a.disable('x-powered-by');
  a.setGlobalPrefix('api/v1');
  a.use((req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
    const rid = String(req.headers['x-cloud-trace-context'] ?? '').split('/')[0] || randomUUID();
    req.requestId = rid;
    res.setHeader('X-Request-Id', rid);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const t0 = Date.now();
    res.on('finish', () => {
      if (config.isTest) return;
      const actor = (req as Request & { actor?: { id: string } }).actor;
      console.log(JSON.stringify({ severity: res.statusCode >= 500 ? 'ERROR' : 'INFO', requestId: rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, userId: actor?.id ?? null }));
    });
    next();
  });
  // webhook は署名を確かめるため、元の本文を残す
  a.use('/api/v1/webhooks/mail-events', express.raw({ type: '*/*', limit: '2mb' }), (req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction) => {
    if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
    next();
  });
  a.use(express.json({ limit: '1mb' }));
  a.use(express.urlencoded({ extended: false, limit: '100kb' }));
  a.use(cookieParser());
  return a;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  new Logger('SoilFlow').log(`API http://localhost:${config.port}/api/v1（外部：${config.adapters}）`);
}
if (require.main === module) bootstrap();
