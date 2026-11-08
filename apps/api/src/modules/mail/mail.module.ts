import { Global, Module } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { LogMailService, MailService, MemoryMailService } from './mail.service';
import { SmtpMailService } from './smtp-mail.service';

@Global()
@Module({
  providers: [
    {
      provide: MailService,
      inject: [ENV],
      useFactory: (env: Env): MailService => {
        if (env.MAIL_TRANSPORT === 'smtp') return SmtpMailService.fromUrl(env.SMTP_URL!, env.MAIL_FROM);
        return env.MAIL_TRANSPORT === 'memory' ? new MemoryMailService() : new LogMailService();
      },
    },
  ],
  exports: [MailService],
})
export class MailModule {}
