import { Injectable, Logger } from '@nestjs/common';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

export abstract class MailService {
  abstract send(mail: OutboundMail): Promise<void>;
}

/**
 * Development transport: writes the message to the application log.
 * An SMTP/SES transport is planned with the notifications module (Phase 8).
 */
@Injectable()
export class LogMailService extends MailService {
  private readonly logger = new Logger('Mail');
  async send(mail: OutboundMail): Promise<void> {
    this.logger.warn({ to: mail.to, subject: mail.subject, text: mail.text }, 'Outbound mail (log transport)');
  }
}

/** Test transport: keeps messages in memory so tests can read reset links. */
@Injectable()
export class MemoryMailService extends MailService {
  readonly outbox: OutboundMail[] = [];
  async send(mail: OutboundMail): Promise<void> {
    this.outbox.push(mail);
  }
}
