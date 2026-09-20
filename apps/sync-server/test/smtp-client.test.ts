import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { buildMessage, sendAlertEmail } from '../src/smtp-client.js';
import type { EmailChannel } from '../src/alert-channels.js';

const notification = {
  key: 'disk-low',
  rule: '磁盘空间不足',
  scope: 'server',
  severity: 'warning',
  state: 'active' as const,
  at: '2026-09-20T10:00:00.000Z',
  detail: { freeBytes: 123 },
};

/**
 * A tiny SMTP server that records the conversation.
 *
 * The point is to drive the client through a real socket, so the line protocol is exercised rather
 * than mocked: a mock would agree with whatever the client sends, including a wrong one.
 */
function fakeSmtp(options: { advertiseStartTls?: boolean; rejectAuth?: boolean; rejectRecipient?: boolean } = {}) {
  const received: string[] = [];
  const server: Server = createServer((socket) => {
    let buffer = '';
    let inData = false;
    /** 0 = not authenticating, 1 = username expected, 2 = password expected, 3 = done. */
    let authStep = 0;
    const send = (line: string): void => { socket.write(`${line}\r\n`); };
    send('220 fake ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (inData) {
        if (!buffer.includes('\r\n.\r\n')) return;
        const body = buffer.slice(0, buffer.indexOf('\r\n.\r\n'));
        received.push(body);
        buffer = '';
        inData = false;
        send('250 2.0.0 Ok: queued');
        return;
      }
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        if (line.startsWith('EHLO')) {
          send('250-fake greets you');
          if (options.advertiseStartTls) send('250-STARTTLS');
          send('250 AUTH LOGIN PLAIN');
        } else if (line === 'STARTTLS') send('220 2.0.0 Ready to start TLS');
        else if (line === 'AUTH LOGIN') { authStep += 1; send('334 VXNlcm5hbWU6'); }
        // The credential lines are bare base64. Checked after the named commands so a literal
        // command that happens to look like base64 (DATA is a valid base64 alphabet) is not eaten.
        else if (authStep === 1) {
          authStep += 1;
          send('334 UGFzc3dvcmQ6');
        } else if (authStep === 2) {
          authStep += 1;
          if (options.rejectAuth) send('535 5.7.8 Authentication credentials invalid');
          else send('235 2.7.0 Authentication successful');
        } else if (line.startsWith('MAIL FROM')) send('250 2.1.0 Ok');
        else if (line.startsWith('RCPT TO')) {
          if (options.rejectRecipient) send('550 5.1.1 No such user');
          else send('250 2.1.5 Ok');
        } else if (line === 'DATA') { inData = true; send('354 End data with <CR><LF>.<CR><LF>'); }
        else if (line === 'QUIT') { send('221 2.0.0 Bye'); socket.end(); }
        else send('250 2.0.0 Ok');
        index = buffer.indexOf('\r\n');
      }
    });
  });
  return { server, received };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return address.port;
}

const channelFor = (port: number, overrides: Partial<EmailChannel> = {}): EmailChannel => ({
  kind: 'email',
  name: 'ops-mail',
  host: '127.0.0.1',
  port,
  secure: false,
  // The fake server has no TLS, so the handshake test below turns this off explicitly.
  requireTls: false,
  user: 'alerts@example.com',
  password: 'relay-password',
  from: 'alerts@example.com',
  to: ['oncall@example.com'],
  enabled: true,
  ...overrides,
});

describe('SMTP delivery', () => {
  it('delivers a message over a real socket', async () => {
    const { server, received } = fakeSmtp();
    const port = await listen(server);
    await sendAlertEmail(channelFor(port), notification);

    const conversation = received.join('\n');
    expect(conversation).toContain('EHLO');
    expect(conversation).toContain('AUTH LOGIN');
    expect(conversation).toContain('MAIL FROM:<alerts@example.com>');
    expect(conversation).toContain('RCPT TO:<oncall@example.com>');
    // The subject arrives base64-encoded so Chinese survives without an encoded-word splitter.
    const body = received.find((entry) => entry.includes('Subject:')) ?? '';
    expect(body).toContain('Content-Type: text/plain; charset=utf-8');
    expect(body).toContain('=?UTF-8?B?');
  });

  it('refuses to send a login when the server offers no STARTTLS', async () => {
    const { server, received } = fakeSmtp({ advertiseStartTls: false });
    const port = await listen(server);
    // requireTls is on by default; a server that cannot upgrade must not receive the password.
    await expect(sendAlertEmail(channelFor(port, { requireTls: true }), notification)).rejects.toThrow(/STARTTLS/);
    expect(received.join('\n')).not.toContain('AUTH LOGIN');
  });

  it('surfaces an authentication failure instead of reporting success', async () => {
    const { server } = fakeSmtp({ rejectAuth: true });
    const port = await listen(server);
    await expect(sendAlertEmail(channelFor(port), notification)).rejects.toThrow(/AUTH/);
  });

  it('fails the channel when a recipient is refused', async () => {
    const { server } = fakeSmtp({ rejectRecipient: true });
    const port = await listen(server);
    await expect(sendAlertEmail(channelFor(port), notification)).rejects.toThrow(/RCPT/);
  });

  it('never echoes a credential into the failure reason', async () => {
    const { server } = fakeSmtp({ rejectAuth: true });
    const port = await listen(server);
    // The reason is stored on the alert row and rendered on the console page, so the base64
    // password must not appear in it.
    const reason = await sendAlertEmail(channelFor(port), notification).then(() => '', (error: Error) => error.message);
    expect(reason).toContain('AUTH');
    expect(reason).not.toContain(Buffer.from('relay-password', 'utf8').toString('base64'));
  });

  it('refuses a header value containing a newline', () => {
    // SMTP is line-oriented: an injected CR/LF would turn one header into another command.
    expect(() => buildMessage({
      from: 'a@b.c', to: ['x@y.z'], subject: 'ok\r\nBcc: victim@example.com',
      body: 'hi', messageId: '<1@zichan>', date: 'now',
    })).not.toThrow(); // the subject is sanitised rather than rejected
    const message = buildMessage({
      from: 'a@b.c', to: ['x@y.z'], subject: 'ok\r\nBcc: victim@example.com',
      body: 'hi', messageId: '<1@zichan>', date: 'now',
    });
    expect(message).not.toContain('Bcc:');
    // An address, by contrast, is refused outright: there is no safe way to sanitise it.
    expect(() => buildMessage({
      from: 'a@b.c', to: ['x@y.z\r\nRCPT TO:<victim@example.com>'], subject: 'ok',
      body: 'hi', messageId: '<1@zichan>', date: 'now',
    })).toThrow(/邮件地址无效/);
  });

  it('escapes a leading dot in the body so it cannot terminate the message early', () => {
    const message = buildMessage({
      from: 'a@b.c', to: ['x@y.z'], subject: 'ok', body: '.hidden\n正常',
      messageId: '<1@zichan>', date: 'now',
    });
    expect(message).toContain('..hidden');
  });
});
