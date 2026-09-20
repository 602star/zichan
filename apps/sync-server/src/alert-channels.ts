/**
 * Alert notification channels.
 *
 * Until now there was exactly one destination: a single webhook URL. That answers "tell someone"
 * but not the questions an operator actually has — send it to the team chat *and* the on-call
 * endpoint, or send email when nobody is watching a chat. So a channel is now a named destination
 * with a format, and several can be configured at once.
 *
 * Three decisions are deliberate:
 *
 * 1. **A channel's failure is reported per channel, not folded into one word.** "Notification
 *    failed" is not actionable when three channels are configured and only the email relay is
 *    broken. Each channel's own result is recorded and shown.
 * 2. **One broken channel never blocks the others.** Delivery is attempted for every enabled
 *    channel regardless of what happened before it, because a chat webhook being down must not
 *    silently stop the email that would have reached someone.
 * 3. **The stored credential is never echoed back.** Email needs a password, and a settings page
 *    that renders it in full turns every screenshot and support thread into a leak. The read path
 *    returns a placeholder; saving that placeholder means "keep what is stored".
 *
 * The SMTP client is written here rather than pulled in: this server has one runtime dependency by
 * design and is bundled into a single file, and SMTP is a small enough line protocol to implement
 * and test against a real socket.
 */

/** Placeholder returned instead of a stored credential. Saving it back means "unchanged". */
export const SECRET_PLACEHOLDER = '********';

export const WEBHOOK_FORMATS = ['generic', 'slack', 'discord', 'feishu', 'dingtalk', 'wecom', 'text'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export interface WebhookChannel {
  kind: 'webhook';
  name: string;
  url: string;
  format: WebhookFormat;
  enabled: boolean;
}

export interface EmailChannel {
  kind: 'email';
  name: string;
  host: string;
  port: number;
  /** Implicit TLS from the first byte (port 465). STARTTLS is used when this is false. */
  secure: boolean;
  /** Whether to attempt STARTTLS when the server advertises it. Off is only sensible on a trusted LAN. */
  requireTls: boolean;
  user: string;
  password: string;
  from: string;
  to: string[];
  enabled: boolean;
}

export type AlertChannel = WebhookChannel | EmailChannel;

export interface AlertNotification {
  key: string;
  rule: string;
  scope: string;
  severity: string;
  state: 'active' | 'resolved';
  at: string;
  detail: Record<string, unknown>;
}

export interface ChannelResult {
  name: string;
  kind: AlertChannel['kind'];
  state: 'sent' | 'failed' | 'skipped';
  error?: string;
}

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
/** Deliberately permissive: a hostname or an IP literal, not a URL. */
const HOST_PATTERN = /^[A-Za-z0-9._:[\]-]{1,255}$/;
const ADDRESS_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asAddresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => asString(entry)).filter(Boolean);
  // A comma-separated string is what people actually type into a "to" box.
  return asString(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Parses the stored channel list.
 *
 * Throws with a specific reason rather than dropping a bad entry: a channel that silently
 * disappears is a channel nobody knows is not delivering. The caller turns this into a 400.
 */
export function parseAlertChannels(raw: unknown): AlertChannel[] {
  if (raw === undefined || raw === null || raw === '') return [];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); }
    catch { throw new Error('告警渠道必须是一段 JSON 数组'); }
  }
  if (!Array.isArray(value)) throw new Error('告警渠道必须是一段 JSON 数组');
  if (value.length > 10) throw new Error('告警渠道最多 10 个');
  const channels: AlertChannel[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const row = asRecord(entry);
    if (!row) throw new Error(`第 ${index + 1} 个告警渠道必须是一个对象`);
    const name = asString(row['name']);
    if (!NAME_PATTERN.test(name)) throw new Error(`第 ${index + 1} 个告警渠道的名称无效（只允许字母、数字、点、下划线、连字符，最多 40 字符）`);
    if (seen.has(name)) throw new Error(`告警渠道名称重复：${name}`);
    seen.add(name);
    // Absent means enabled: a channel someone added is one they expect to receive from.
    const enabled = row['enabled'] === undefined ? true : row['enabled'] === true;
    const kind = asString(row['kind']) || 'webhook';
    if (kind === 'webhook') {
      const url = asString(row['url']);
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(`告警渠道 ${name} 的地址必须是 http(s) 地址`);
      if (url.length > 500) throw new Error(`告警渠道 ${name} 的地址过长`);
      const format = (asString(row['format']) || 'generic') as WebhookFormat;
      if (!WEBHOOK_FORMATS.includes(format)) throw new Error(`告警渠道 ${name} 的格式无效（可选：${WEBHOOK_FORMATS.join('、')}）`);
      channels.push({ kind: 'webhook', name, url, format, enabled });
      return;
    }
    if (kind === 'email') {
      const host = asString(row['host']);
      if (!HOST_PATTERN.test(host)) throw new Error(`告警渠道 ${name} 的邮件服务器地址无效`);
      const port = row['port'] === undefined ? (row['secure'] === true ? 465 : 587) : Number(row['port']);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`告警渠道 ${name} 的邮件端口无效`);
      const from = asString(row['from']);
      if (!ADDRESS_PATTERN.test(from)) throw new Error(`告警渠道 ${name} 的发件地址无效`);
      const to = asAddresses(row['to']);
      if (!to.length) throw new Error(`告警渠道 ${name} 缺少收件地址`);
      if (to.length > 20) throw new Error(`告警渠道 ${name} 的收件人最多 20 个`);
      const bad = to.find((address) => !ADDRESS_PATTERN.test(address));
      if (bad) throw new Error(`告警渠道 ${name} 的收件地址无效：${bad}`);
      const user = asString(row['user']);
      const password = typeof row['password'] === 'string' ? row['password'] : '';
      if (user && !password) throw new Error(`告警渠道 ${name} 填写了用户名但没有密码`);
      if (password && !user) throw new Error(`告警渠道 ${name} 填写了密码但没有用户名`);
      channels.push({
        kind: 'email', name, host, port,
        secure: row['secure'] === true,
        // Default on: silently sending credentials or content in the clear is the wrong default.
        requireTls: row['requireTls'] === undefined ? true : row['requireTls'] === true,
        user, password, from, to, enabled,
      });
      return;
    }
    throw new Error(`告警渠道 ${name} 的类型无效（可选：webhook、email）`);
  });
  return channels;
}

/** The summary line every text-based format sends. */
export function summarize(notification: AlertNotification): string {
  const verb = notification.state === 'active' ? '告警' : '已恢复';
  const severity = notification.severity === 'critical' ? '严重' : notification.severity === 'warning' ? '警告' : notification.severity;
  return `[${verb}] ${notification.rule}（${severity}）\n范围：${notification.scope}\n时间：${notification.at}`;
}

/**
 * Builds the request body for a webhook format.
 *
 * Each service wants a different envelope around the same sentence. Sending the generic JSON to a
 * chat service produces a 400 that looks like a network problem, which is why the format is an
 * explicit choice rather than something guessed from the URL.
 */
export function webhookPayload(format: WebhookFormat, notification: AlertNotification): { contentType: string; body: string } {
  const text = summarize(notification);
  const json = (value: unknown): { contentType: string; body: string } => ({ contentType: 'application/json', body: JSON.stringify(value) });
  switch (format) {
    case 'slack': return json({ text });
    case 'discord': return json({ content: text });
    case 'feishu': return json({ msg_type: 'text', content: { text } });
    case 'dingtalk': return json({ msgtype: 'text', text: { content: text } });
    case 'wecom': return json({ msgtype: 'text', text: { content: text } });
    case 'text': return { contentType: 'text/plain; charset=utf-8', body: text };
    default: return json(notification);
  }
}

/** Redacts the credential from a channel before it is returned to a browser. */
export function maskChannel(channel: AlertChannel): AlertChannel {
  if (channel.kind !== 'email') return channel;
  return { ...channel, password: channel.password ? SECRET_PLACEHOLDER : '' };
}

/**
 * Re-applies stored credentials when the browser echoes the placeholder back.
 *
 * The placeholder is what the read path returned, so seeing it on save means "I did not touch this
 * field" — treating it as a literal password would lock the operator out of their own relay.
 */
export function mergeChannelSecrets(next: AlertChannel[], stored: AlertChannel[]): AlertChannel[] {
  const byName = new Map(stored.map((channel) => [channel.name, channel]));
  return next.map((channel) => {
    if (channel.kind !== 'email' || channel.password !== SECRET_PLACEHOLDER) return channel;
    const previous = byName.get(channel.name);
    return previous && previous.kind === 'email' ? { ...channel, password: previous.password } : { ...channel, password: '' };
  });
}
