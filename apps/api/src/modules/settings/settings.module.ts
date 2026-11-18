/* システム設定（FR-CMN-05、SCR-62） */
import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { z } from 'zod';
import { Actor, CurrentActor, Roles } from '../../common/actor';
import { AuditService } from '../../common/audit.service';
import { conflict } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { parse } from '../../common/validation';
import type { Setting } from '../../generated/prisma/client';

export function settingsDto(s: Setting) {
  return {
    companyName: s.companyName, officeName: s.officeName, postalCode: s.postalCode, address: s.address, tel: s.tel, fax: s.fax,
    invoiceRegistrationNo: s.invoiceRegistrationNo, bankAccountText: s.bankAccountText, invoiceNote: s.invoiceNote,
    mailFromAddress: s.mailFromAddress, mailFromName: s.mailFromName, mailReplyTo: s.mailReplyTo,
    mailSubjectTemplate: s.mailSubjectTemplate, mailBodyTemplate: s.mailBodyTemplate,
    reportFirstHour: s.reportFirstHour, reportLastHour: s.reportLastHour, taxRate: s.taxRate, taxRounding: s.taxRounding as 'floor' | 'round' | 'ceil',
    slipWarningEnabled: s.slipWarningEnabled, version: s.version,
  };
}
export type SettingsDto = ReturnType<typeof settingsDto>;

const nullableText = z.string().max(500).nullable().optional().transform((v) => (v === '' ? null : v));
const SettingsInput = z.object({
  version: z.number().int(),
  companyName: z.string().trim().min(1).max(100).optional(), officeName: z.string().trim().min(1).max(100).optional(),
  postalCode: nullableText, address: nullableText, tel: nullableText, fax: nullableText,
  invoiceRegistrationNo: z.string().regex(/^T[0-9]{13}$/, '登録番号は T＋13桁').nullable().optional(),
  bankAccountText: nullableText, invoiceNote: z.string().max(2000).nullable().optional(),
  mailFromAddress: z.string().email().nullable().optional(), mailFromName: nullableText, mailReplyTo: z.string().email().nullable().optional(),
  mailSubjectTemplate: z.string().trim().min(1).max(300).optional(), mailBodyTemplate: z.string().trim().min(1).max(5000).optional(),
  reportFirstHour: z.number().int().min(0).max(23).optional(), reportLastHour: z.number().int().min(0).max(23).optional(),
  taxRate: z.number().int().min(0).max(100).optional(), taxRounding: z.enum(['floor', 'round', 'ceil']).optional(),
  slipWarningEnabled: z.boolean().optional(),
}).strict();

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}
  async get(tx: Tx | PrismaService = this.prisma): Promise<SettingsDto> {
    return settingsDto(await tx.setting.findUniqueOrThrow({ where: { id: 1 } }));
  }
  async update(actor: Actor, body: unknown) {
    const { version, ...input } = parse(SettingsInput, body);
    return this.prisma.tx(async (tx) => {
      const before = await tx.setting.findUniqueOrThrow({ where: { id: 1 } });
      const r = await tx.setting.updateMany({ where: { id: 1, version }, data: { ...input, updatedBy: actor.id, version: { increment: 1 } } });
      if (!r.count) throw conflict();
      const after = await tx.setting.findUniqueOrThrow({ where: { id: 1 } });
      const changed = Object.keys(input);
      await this.audit.write(tx, actor, { action: 'SETTINGS_UPDATE', targetType: 'settings', targetId: '1', summary: `システム設定を変更（${changed.join('・')}）`, before: pick(settingsDto(before), changed), after: pick(settingsDto(after), changed) });
      return settingsDto(after);
    });
  }
}
const pick = (o: Record<string, unknown>, ks: string[]) => Object.fromEntries(ks.map((k) => [k, o[k]]));

@Controller('settings')
export class SettingsController {
  constructor(private readonly s: SettingsService) {}
  @Get() @Roles('OFFICE', 'ADMIN') get() { return this.s.get(); }
  @Patch() @Roles('ADMIN') update(@CurrentActor() a: Actor, @Body() b: unknown) { return this.s.update(a, b); }
}

@Module({ providers: [SettingsService], controllers: [SettingsController], exports: [SettingsService] })
export class SettingsModule {}
