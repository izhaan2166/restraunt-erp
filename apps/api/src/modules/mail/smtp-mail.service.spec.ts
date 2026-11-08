import { createTransport } from 'nodemailer';
import { SmtpMailService } from './smtp-mail.service';

describe('SmtpMailService', () => {
  it('sends a plain-text message from the configured sender', async () => {
    const transport = createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const sent: string[] = [];
    const real = transport.sendMail.bind(transport);
    transport.sendMail = (async (m: Parameters<typeof real>[0]) => {
      const info = await real(m);
      sent.push((info.message as Buffer).toString('utf8'));
      return info;
    }) as typeof transport.sendMail;
    const mail = new SmtpMailService(transport, 'Spice Garden <no-reply@spice.example.in>');
    await mail.send({ to: 'owner@example.in', subject: 'Reset your password', text: 'Open https://pos.example.in/reset?token=abc' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^From: Spice Garden <no-reply@spice\.example\.in>$/m);
    expect(sent[0]).toMatch(/^To: owner@example\.in$/m);
    expect(sent[0]).toMatch(/^Content-Type: text\/plain/m);
    expect(sent[0]).toContain('reset?token=abc');
  });

  it('reports a delivery failure to the caller', async () => {
    const transport = createTransport({ streamTransport: true });
    transport.sendMail = (() => Promise.reject(new Error('550 mailbox unavailable'))) as unknown as typeof transport.sendMail;
    await expect(new SmtpMailService(transport, 'x@example.in').send({ to: 'a@example.in', subject: 's', text: 't' })).rejects.toThrow('550');
  });
});
