import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdaptersModule } from './adapters/adapters.module';
import { AuditService } from './common/audit.service';
import { AppExceptionFilter } from './common/error.filter';
import { PrismaService } from './common/prisma.service';
import { AggregatesModule } from './modules/aggregates/aggregates.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { FreeeModule } from './modules/freee/freee.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MailModule } from './modules/mail/mail.module';
import { MastersModule } from './modules/masters/masters.module';
import { PdfModule } from './modules/pdf/pdf.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SlipsModule } from './modules/slips/slips.module';
import { CashModule } from './modules/cash/cash.module';
import { SystemModule } from './modules/system/system.module';
import { UsersModule } from './modules/users/users.module';

@Global()
@Module({ providers: [PrismaService, AuditService], exports: [PrismaService, AuditService] })
export class CoreModule {}

@Global()
@Module({ imports: [SettingsModule], exports: [SettingsModule] })
export class SharedSettingsModule {}

@Module({
  imports: [
    CoreModule, AdaptersModule, SharedSettingsModule, JobsModule, PdfModule, AuthModule, UsersModule, MastersModule, ReportsModule, SlipsModule, CashModule,
    BillingModule, MailModule, FreeeModule, AggregatesModule, SystemModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: AppExceptionFilter }],
})
export class AppModule {}
