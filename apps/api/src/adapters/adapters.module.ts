/* 外部とつなぐ部品。ADAPTERS=real で本物、それ以外（ローカル・試験）はにせもの（14 7章） */
import { Global, Module } from '@nestjs/common';
import { config } from '../common/config';
import { FakeFreee, FREEE, HttpFreee } from './freee';
import { GcpKms, KMS, LocalKms } from './kms';
import { FakeMail, MAIL, SendGridMail } from './mail';
import { GcsStorage, LocalStorage, STORAGE } from './storage';

const real = () => config.adapters === 'real';

@Global()
@Module({
  providers: [
    { provide: STORAGE, useFactory: () => (real() && config.gcsBucket ? new GcsStorage() : new LocalStorage()) },
    { provide: KMS, useFactory: () => (real() && config.kmsKeyName ? new GcpKms() : new LocalKms()) },
    { provide: MAIL, useFactory: () => (real() && config.sendgridApiKey ? new SendGridMail() : new FakeMail()) },
    { provide: FREEE, useFactory: () => (real() && config.freeeClientId ? new HttpFreee() : new FakeFreee()) },
  ],
  exports: [STORAGE, KMS, MAIL, FREEE],
})
export class AdaptersModule {}
