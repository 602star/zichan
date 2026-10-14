import { Button, Field, Notice, Select, TextInput, muted, row } from './ui.js';

type ChannelDraft = Record<string, unknown>;
const formats = ['generic', 'slack', 'discord', 'feishu', 'dingtalk', 'wecom', 'text', 'bark'];
const stringValue = (value: unknown): string => typeof value === 'string' ? value : '';

function nextName(channels: ChannelDraft[], prefix: string): string {
  const names = new Set(channels.map((channel) => channel['name']));
  let name = prefix;
  for (let suffix = 2; names.has(name); suffix += 1) name = `${prefix}-${suffix}`;
  return name;
}

export function NotificationChannelsEditor({ value, disabled, onChange }: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  let channels: ChannelDraft[];
  try {
    const parsed: unknown = value ? JSON.parse(value) : [];
    if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error();
    channels = parsed as ChannelDraft[];
  } catch {
    return <Notice tone="bad">已保存的通知渠道格式无效，请在部署配置中修正 ADMIN_ALERT_CHANNELS。</Notice>;
  }
  const commit = (next: ChannelDraft[]) => onChange(next.length ? JSON.stringify(next) : '');
  const update = (index: number, patch: ChannelDraft) => commit(channels.map((channel, position) => position === index ? { ...channel, ...patch } : channel));
  const addEmail = () => commit([...channels, {
    kind: 'email', name: nextName(channels, 'mail'), enabled: true,
    host: '', port: 465, secure: true, requireTls: true, ignoreTlsErrors: false, user: '', password: '', from: '', to: [],
  }]);
  const addWebhook = (format: string) => commit([...channels, {
    kind: 'webhook', name: nextName(channels, format), enabled: true,
    url: format === 'bark' ? 'https://api.day.app/push' : '', format,
    ...(format === 'bark' ? { deviceKey: '', group: '资产账本' } : {}),
  }]);
  const input = (index: number, channel: ChannelDraft, key: string, placeholder?: string, type?: string) =>
    <TextInput type={type} value={stringValue(channel[key])} placeholder={placeholder} disabled={disabled}
      onChange={(event) => update(index, { [key]: event.target.value })} style={{ width: '100%' }} />;

  return <div style={{ display: 'grid', gap: 12 }}>
    <p style={muted}>启用的第一个 SMTP 渠道用于账号验证与密码找回；填写告警收件人后也发送服务器告警。Webhook 用于服务器告警。密码与 Bark 设备密钥保存后只显示占位符。</p>
    {channels.map((channel, index) => {
      const kind = channel['kind'] === 'email' ? 'email' : 'webhook';
      const format = stringValue(channel['format']) || 'generic';
      const label = kind === 'email' ? 'SMTP 邮件' : format === 'bark' ? 'Bark 推送' : 'Webhook';
      return <div key={index} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <strong>{label} · {stringValue(channel['name']) || `渠道 ${index + 1}`}</strong>
          <div style={row}>
            <label><input type="checkbox" checked={channel['enabled'] !== false} disabled={disabled}
              onChange={(event) => update(index, { enabled: event.target.checked })} /> 启用</label>
            <Button disabled={disabled} onClick={() => commit(channels.filter((_, position) => position !== index))}>删除</Button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Field label="渠道名称（字母、数字、点、下划线、连字符）">{input(index, channel, 'name')}</Field>
          {kind === 'email' ? <>
            <Field label="SMTP 服务器">{input(index, channel, 'host', 'smtp.example.com')}</Field>
            <Field label="端口"><TextInput type="number" min={1} max={65535} value={String(channel['port'] ?? '')} disabled={disabled}
              onChange={(event) => update(index, { port: Number(event.target.value) })} /></Field>
            <Field label="连接加密"><Select value={channel['secure'] === true ? 'tls' : 'starttls'} disabled={disabled}
              onChange={(event) => update(index, { secure: event.target.value === 'tls', requireTls: true, port: event.target.value === 'tls' ? 465 : 587 })}>
              <option value="tls">TLS（通常 465）</option><option value="starttls">STARTTLS（通常 587）</option>
            </Select></Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={channel['ignoreTlsErrors'] === true} disabled={disabled}
                onChange={(event) => update(index, { ignoreTlsErrors: event.target.checked })} />
              忽略 TLS 证书验证错误
            </label>
            {channel['ignoreTlsErrors'] === true ? <p style={muted}>仍使用 TLS 加密连接，但不验证邮件服务器证书；仅在使用自签名证书等确有需要时开启。</p> : null}
            <Field label="SMTP 用户名">{input(index, channel, 'user')}</Field>
            <Field label="SMTP 密码或授权码">{input(index, channel, 'password', '留空表示无需认证', 'password')}</Field>
            <Field label="发件邮箱">{input(index, channel, 'from', 'alerts@example.com')}</Field>
            <Field label="告警收件邮箱（可选，逗号分隔）"><TextInput value={Array.isArray(channel['to']) ? channel['to'].join(', ') : stringValue(channel['to'])}
              disabled={disabled} placeholder="ops@example.com" style={{ width: '100%' }}
              onChange={(event) => update(index, { to: event.target.value })} /></Field>
          </> : <>
            <Field label={format === 'bark' ? 'Bark 服务地址（以 /push 结尾）' : 'Webhook 地址'}>{input(index, channel, 'url', format === 'bark' ? 'https://api.day.app/push' : 'https://example.com/hook')}</Field>
            <Field label="请求格式"><Select value={format} disabled={disabled} onChange={(event) => update(index, { format: event.target.value })}>
              {formats.map((item) => <option key={item} value={item}>{item === 'bark' ? 'Bark' : item}</option>)}
            </Select></Field>
            {format === 'bark' ? <>
              <Field label="设备密钥">{input(index, channel, 'deviceKey', '从 Bark 应用复制', 'password')}</Field>
              <Field label="推送分组">{input(index, channel, 'group', '资产账本')}</Field>
            </> : null}
          </>}
        </div>
      </div>;
    })}
    {channels.length < 10 ? <div style={row}>
      <Button disabled={disabled} onClick={addEmail}>添加 SMTP 邮件</Button>
      <Button disabled={disabled} onClick={() => addWebhook('bark')}>添加 Bark 推送</Button>
      <Button disabled={disabled} onClick={() => addWebhook('generic')}>添加其他 Webhook</Button>
    </div> : <p style={muted}>最多配置 10 个渠道。</p>}
  </div>;
}
