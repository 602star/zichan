/**
 * SMTP delivery for alert notifications.
 *
 * Written here rather than pulled in: this server keeps a single runtime dependency by design and
 * is bundled into one file, and the part of SMTP that sending a message needs is small — EHLO,
 * optional STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA. The handshake is done against a real socket in
 * the tests, including the TLS upgrade, so this is not "it compiles" code.
 *
 * Two things are refused rather than downgraded:
 *
 * - **A plaintext login.** If the server does not offer STARTTLS and the channel requires it, the
 *   attempt fails. Sending a relay password in the clear because the negotiation did not work is
 *   exactly the silent downgrade that makes a "secure" setting meaningless.
 * - **A message with a newline in an address.** SMTP is line-oriented, so a CR/LF smuggled into a
 *   recipient would let one header turn into another command. Addresses are validated on parse and
 *   checked again here.
 */
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { summarize, type EmailChannel, type AlertNotification } from './alert-channels.js';

/** One reply line, or a multiline reply ending with `code + space`. */
function readReply(socket: Socket | TLSSocket, timeoutMs: number): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      // Keep the trailing partial line; a reply may arrive in pieces.
      buffer = lines.pop() ?? '';
      const complete = lines.filter(Boolean);
      if (!complete.length) return;
      const last = complete[complete.length - 1]!;
      const match = /^(\d{3})([ -])/.exec(last);
      if (!match || match[2] === '-') return;
      cleanup();
      resolve({ code: Number(match[1]), text: complete.join('\n') });
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('邮件服务器响应超时')); }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(
  socket: Socket | TLSSocket,
  line: string,
  timeoutMs: number,
  expect = [2, 3],
  /** Overrides what an error names. Used for the AUTH exchange, whose arguments are credentials. */
  label: string = 'command',
): Promise<{ code: number; text: string }> {
  socket.write(`${line}\r\n`);
  const reply = await readReply(socket, timeoutMs);
  if (!expect.some((prefix) => String(reply.code).startsWith(String(prefix)))) {
    // Never echo a credential: the AUTH exchange sends the username and password as bare base64
    // lines, and this string is stored on the alert row and rendered on the console page.
    throw new Error(`邮件服务器拒绝了 ${label}：${reply.text.split('\n')[0]}`);
  }
  return reply;
}

/** Minimal quoting for a display name, per RFC 5322's atom rules. */
function quoteDisplayName(value: string): string {
  return /^[A-Za-z0-9 ._-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`;
}

function formatAddress(address: string, displayName?: string): string {
  const trimmed = address.trim();
  if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(trimmed)) throw new Error(`邮件地址无效：${address}`);
  return displayName ? `${quoteDisplayName(displayName)} <${trimmed}>` : `<${trimmed}>`;
}

/**
 * Builds the DATA payload.
 *
 * Headers are assembled here rather than by string concatenation at the call site so the one thing
 * that must not happen — a value containing CR/LF becoming a new header — is checked in one place.
 */
export function buildMessage(input: {
  from: string;
  fromName?: string;
  to: string[];
  subject: string;
  body: string;
  messageId: string;
  date: string;
}): string {
  const header = (name: string, value: string): string => {
    if (/[\r\n]/.test(value)) throw new Error(`邮件头 ${name} 含有换行符`);
    return `${name}: ${value}`;
  };
  const recipients = input.to.map((address) => formatAddress(address));
  const subject = input.subject.replace(/[\r\n]+/g, ' ').slice(0, 200);
  // Base64 keeps a Chinese subject intact without needing an encoded-word splitter.
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const body = input.body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return [
    header('From', formatAddress(input.from, input.fromName)),
    header('To', recipients.join(', ')),
    header('Subject', encodedSubject),
    header('Date', input.date),
    header('Message-ID', input.messageId),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}

export interface SmtpOptions {
  timeoutMs?: number;
  /** Injectable so a test can drive the protocol without a real server. */
  connect?: (channel: EmailChannel, timeoutMs: number) => Promise<Socket | TLSSocket>;
}

async function openSocket(channel: EmailChannel, timeoutMs: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = channel.secure
      ? connectTls({ host: channel.host, port: channel.port, servername: channel.host, rejectUnauthorized: !channel.ignoreTlsErrors })
      : connectTcp({ host: channel.host, port: channel.port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接邮件服务器超时')); }, timeoutMs);
    const fail = (error: Error): void => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once(channel.secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); socket.off('error', fail); resolve(socket); });
  });
}

function upgradeToTls(socket: Socket, channel: EmailChannel, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = connectTls({ socket, servername: channel.host, rejectUnauthorized: !channel.ignoreTlsErrors });
    const timer = setTimeout(() => { secure.destroy(); reject(new Error('STARTTLS 握手超时')); }, timeoutMs);
    secure.once('secureConnect', () => { clearTimeout(timer); resolve(secure); });
    secure.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
  });
}

/** Sends one plain-text message through a configured SMTP transport. */
export async function sendEmail(channel: EmailChannel, message: { to: string[]; subject: string; body: string }, options: SmtpOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const payload = buildMessage({
    from: channel.from,
    fromName: 'Zichan',
    to: message.to,
    subject: message.subject,
    body: message.body,
    messageId: `<${randomBytes(12).toString('hex')}@zichan>`,
    date: new Date().toUTCString(),
  });
  let socket = await (options.connect ?? openSocket)(channel, timeoutMs);
  try {
    const greeting = await readReply(socket, timeoutMs);
    if (greeting.code !== 220) throw new Error(`邮件服务器未就绪：${greeting.text.split('\n')[0]}`);
    const ehlo = await command(socket, `EHLO zichan`, timeoutMs, [2, 3], 'EHLO');
    const capabilities = ehlo.text.toUpperCase();
    if (!channel.secure && channel.requireTls) {
      if (!capabilities.includes('STARTTLS')) throw new Error('邮件服务器不支持 STARTTLS，已按配置拒绝以明文发送');
      await command(socket, 'STARTTLS', timeoutMs, [2], 'STARTTLS');
      const upgraded = await upgradeToTls(socket as Socket, channel, timeoutMs);
      socket.destroy();
      socket = upgraded;
      await command(socket, 'EHLO zichan', timeoutMs, [2, 3], 'EHLO');
    }
    if (channel.user) {
      // AUTH LOGIN carries the password base64-encoded, which is not encryption. When the channel
      // requires TLS the connection is encrypted by now (either implicit TLS or the STARTTLS
      // upgrade above, which fails loudly if it cannot happen). When the operator explicitly turned
      // that requirement off, plaintext is what they asked for — an internal relay on a trusted LAN
      // is a real deployment, and refusing it would make the setting a lie.
      const encrypted = channel.secure || socket instanceof TLSSocket;
      if (!encrypted && channel.requireTls) throw new Error('邮件服务器连接未加密，已拒绝发送登录凭据');
      await command(socket, 'AUTH LOGIN', timeoutMs, [3], 'AUTH');
      await command(socket, Buffer.from(channel.user, 'utf8').toString('base64'), timeoutMs, [3], 'AUTH');
      await command(socket, Buffer.from(channel.password, 'utf8').toString('base64'), timeoutMs, [2], 'AUTH');
    }
    await command(socket, `MAIL FROM:<${channel.from}>`, timeoutMs, [2, 3], 'MAIL FROM');
    for (const address of message.to) await command(socket, `RCPT TO:<${address}>`, timeoutMs, [2, 3], 'RCPT');
    await command(socket, 'DATA', timeoutMs, [3], 'DATA');
    socket.write(`${payload}\r\n.\r\n`);
    const accepted = await readReply(socket, timeoutMs);
    if (accepted.code !== 250) throw new Error(`邮件服务器未接受消息：${accepted.text.split('\n')[0]}`);
    await command(socket, 'QUIT', timeoutMs, [2], 'QUIT').catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

/** Sends an administrator alert using the same SMTP transport. */
export async function sendAlertEmail(channel: EmailChannel, notification: AlertNotification, options: SmtpOptions = {}): Promise<void> {
  const summary = summarize(notification);
  return sendEmail(channel, {
    to: channel.to,
    subject: summary.split('\n')[0]!,
    body: `${summary}\n\n${JSON.stringify(notification.detail, null, 2)}`,
  }, options);
}
