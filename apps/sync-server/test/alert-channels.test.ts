import { describe, expect, it } from 'vitest';
import {
  SECRET_PLACEHOLDER,
  maskChannel,
  mergeChannelSecrets,
  parseAlertChannels,
  summarize,
  webhookPayload,
  type EmailChannel,
} from '../src/alert-channels.js';
import { summarizeChannelResults } from '../src/metrics.js';
import { maskChannelList } from '../src/admin.js';

const notification = {
  key: 'disk-low',
  rule: '磁盘空间不足',
  scope: 'server',
  severity: 'warning',
  state: 'active' as const,
  at: '2026-09-20T10:00:00.000Z',
  detail: { freeBytes: 123 },
};

const emailChannel = (overrides: Partial<EmailChannel> = {}): EmailChannel => ({
  kind: 'email',
  name: 'ops-mail',
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTls: true,
  ignoreTlsErrors: false,
  user: 'alerts@example.com',
  password: 'relay-password',
  from: 'alerts@example.com',
  to: ['oncall@example.com'],
  enabled: true,
  ...overrides,
});

/**
 * Channel configuration and delivery bookkeeping.
 *
 * The failure modes here are all about telling the truth: a channel that silently disappears, a
 * password echoed into a screenshot, and a partial delivery reported as a total failure.
 */
describe('alert channels', () => {
  it('rejects a bad channel with a reason instead of dropping it', () => {
    expect(() => parseAlertChannels('[{"name":"ops","kind":"webhook","url":"not-a-url"}]')).toThrow(/http\(s\) 地址/);
    expect(() => parseAlertChannels('[{"name":"ops","kind":"webhook","url":"https://x.example/hook","format":"nope"}]')).toThrow(/格式无效/);
    expect(() => parseAlertChannels('[{"name":"a","kind":"webhook","url":"https://x/hook"},{"name":"a","kind":"webhook","url":"https://y/hook"}]')).toThrow(/名称重复/);
    expect(() => parseAlertChannels('[{"name":"bad name","kind":"webhook","url":"https://x/hook"}]')).toThrow(/名称无效/);
    expect(() => parseAlertChannels('{')).toThrow(/JSON/);
  });

  it('rejects an email channel that would fail at delivery time', () => {
    expect(parseAlertChannels('[{"name":"m","kind":"email","host":"smtp.example.com","from":"a@b.c","to":[]}]')).toMatchObject([{ kind: 'email', to: [] }]);
    expect(() => parseAlertChannels('[{"name":"m","kind":"email","host":"smtp.example.com","from":"nope","to":["a@b.c"]}]')).toThrow(/发件地址/);
    expect(() => parseAlertChannels('[{"name":"m","kind":"email","host":"smtp.example.com","from":"a@b.c","to":["a@b.c"],"user":"u"}]')).toThrow(/没有密码/);
    expect(() => parseAlertChannels('[{"name":"m","kind":"email","host":"smtp.example.com","from":"a@b.c","to":["a@b.c"],"password":"p"}]')).toThrow(/没有用户名/);
    expect(() => parseAlertChannels('[{"name":"m","kind":"email","host":"smtp.example.com","port":0,"from":"a@b.c","to":["a@b.c"]}]')).toThrow(/端口/);
  });

  it('accepts a comma-separated recipient list and defaults a new channel to enabled', () => {
    const [channel] = parseAlertChannels('[{"name":"m","kind":"email","host":"smtp.example.com","from":"a@b.c","to":"x@y.z, p@q.r"}]');
    expect(channel).toMatchObject({ kind: 'email', enabled: true, to: ['x@y.z', 'p@q.r'], port: 587, ignoreTlsErrors: false });
    expect(parseAlertChannels('[{"name":"m","kind":"email","host":"smtp.example.com","from":"a@b.c","to":[],"ignoreTlsErrors":true}]')).toMatchObject([{ ignoreTlsErrors: true }]);
  });

  it('never returns a stored password to the browser, and keeps it when the mask is saved back', () => {
    const stored = [emailChannel()];
    const masked = maskChannel(stored[0]!) as EmailChannel;
    expect(masked.password).toBe(SECRET_PLACEHOLDER);

    // Saving the masked value unchanged must keep the real password, not store the mask.
    const merged = mergeChannelSecrets([masked], stored) as EmailChannel[];
    expect(merged[0]?.password).toBe('relay-password');

    // A channel that was renamed loses the old password rather than inheriting it by position.
    const renamed = mergeChannelSecrets([{ ...masked, name: 'other' }], stored) as EmailChannel[];
    expect(renamed[0]?.password).toBe('');
  });

  it('validates and masks Bark device keys separately from the endpoint', () => {
    const [stored] = parseAlertChannels(JSON.stringify([{ kind: 'webhook', name: 'phone', format: 'bark', url: 'https://api.day.app/push', deviceKey: 'private-key', group: 'ledger' }]));
    expect(stored).toMatchObject({ format: 'bark', deviceKey: 'private-key', group: 'ledger' });
    const masked = maskChannel(stored!);
    expect(masked).toMatchObject({ deviceKey: SECRET_PLACEHOLDER });
    expect(mergeChannelSecrets([masked], [stored!])).toMatchObject([{ deviceKey: 'private-key' }]);
    expect(() => parseAlertChannels(JSON.stringify([{ kind: 'webhook', name: 'phone', format: 'bark', url: 'https://api.day.app/private-key' }]))).toThrow(/\/push/);
    expect(() => parseAlertChannels(JSON.stringify([{ kind: 'webhook', name: 'phone', format: 'bark', url: 'https://api.day.app/push' }]))).toThrow(/设备密钥/);
    expect(JSON.parse(webhookPayload('bark', notification, stored?.kind === 'webhook' ? stored : undefined).body)).toMatchObject({ device_key: 'private-key', group: 'ledger', title: expect.any(String), body: expect.any(String) });
    expect(maskChannelList(JSON.stringify([stored]))).not.toContain('private-key');
    expect(maskChannelList('[{"kind":"email","password":"secret"}]')).not.toContain('secret');
  });

  it('builds the envelope each chat service actually expects', () => {
    expect(webhookPayload('slack', notification).body).toContain('"text"');
    expect(webhookPayload('discord', notification).body).toContain('"content"');
    expect(JSON.parse(webhookPayload('feishu', notification).body)).toMatchObject({ msg_type: 'text' });
    expect(JSON.parse(webhookPayload('dingtalk', notification).body)).toMatchObject({ msgtype: 'text' });
    expect(JSON.parse(webhookPayload('wecom', notification).body)).toMatchObject({ msgtype: 'text' });
    expect(webhookPayload('text', notification).contentType).toContain('text/plain');
    // The generic format is the whole notification, which is what an existing integration reads.
    expect(JSON.parse(webhookPayload('generic', notification).body)).toMatchObject({ key: 'disk-low', state: 'active' });
    expect(summarize(notification)).toContain('磁盘空间不足');
  });

  it('reports one channel failing while another delivered as sent, not failed', () => {
    // A lost alert and a degraded notification path need different responses; calling this
    // "failed" would send someone looking for an alert that did arrive.
    const partial = summarizeChannelResults([
      { name: 'chat', kind: 'webhook', state: 'sent' },
      { name: 'mail', kind: 'email', state: 'failed', error: '连接超时' },
    ]);
    expect(partial.state).toBe('sent');
    expect(partial.error).toContain('mail');
    expect(partial.error).toContain('连接超时');

    expect(summarizeChannelResults([{ name: 'chat', kind: 'webhook', state: 'failed', error: 'HTTP 500' }]).state).toBe('failed');
    expect(summarizeChannelResults([]).state).toBe('skipped');
    expect(summarizeChannelResults([{ name: 'a', kind: 'webhook', state: 'skipped' }]).state).toBe('skipped');
  });

  it('names every failed channel so a single broken destination is identifiable', () => {
    const result = summarizeChannelResults([
      { name: 'mail-a', kind: 'email', state: 'failed', error: '认证失败' },
      { name: 'mail-b', kind: 'email', state: 'failed', error: '超时' },
    ]);
    expect(result.error).toContain('mail-a');
    expect(result.error).toContain('mail-b');
  });
  it('reports a malformed entry instead of dropping it', () => {
    // A channel that is silently discarded is one nobody knows is not delivering: the operator
    // saves a list, sees no error, and believes the alert will reach the team.
    expect(() => parseAlertChannels('[42]')).toThrow(/第 1 个/);
    expect(() => parseAlertChannels([
      { kind: 'webhook', name: 'ok', url: 'https://example.com/ok' },
      7,
    ])).toThrow(/第 2 个/);
  });
});
