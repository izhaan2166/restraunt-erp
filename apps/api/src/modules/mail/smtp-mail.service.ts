import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { MailService, OutboundMail } from './mail.service';

/**
 * Real email over SMTP (works with Amazon SES, SendGrid, Zoho, Google Workspace and others).
 * Messages are plain text, so nothing user-supplied is ever rendered as HTML in an inbox.
 */
export class SmtpMailService extends MailService {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
  ) {
    super();
  }

  static fromUrl(url: string, from: string) {
    // Options such as ?pool=true can be given in the URL query string.
    return new SmtpMailService(createTransport(url), from);
  }

  async send(mail: OutboundMail): Promise<void> {
    try {
      const info = await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
      this.logger.log({ to: mail.to, subject: mail.subject, messageId: info.messageId }, 'Mail sent');
    } catch (err) {
      // Never include the body: it can hold a password reset link.
      this.logger.error({ to: mail.to, subject: mail.subject, err: (err as Error).message }, 'Mail delivery failed');
      throw err;
    }
  }
}
