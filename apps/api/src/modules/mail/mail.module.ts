import { Global, Module } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { LogMailService, MailService, MemoryMailService } from './mail.service';

@Global()
@Module({
  providers: [
    {
      provide: MailService,
      inject: [ENV],
      useFactory: (env: Env) => (env.MAIL_TRANSPORT === 'memory' ? new MemoryMailService() : new LogMailService()),
    },
  ],
  exports: [MailService],
})
export class MailModule {}
