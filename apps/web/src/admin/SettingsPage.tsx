/** Effective settings: an allow-list, with the source of every value made explicit. */
import { useEffect, useRef, useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { settingNumber } from './number-input.js';
import { Badge, Button, Field, Loading, Notice, Panel, Select, Stat, TextInput, message, muted, row, useResource } from './ui.js';
import { SETTING_GROUPS, settingGroup, mergeSettingDrafts } from './setting-groups.js';
import type { SettingsPayload } from './types.js';

export function SettingsPage({ client, role, query, navigate }: { client: AdminClient; role: string; query: URLSearchParams; navigate: (to: string) => void }) {
  const group = SETTING_GROUPS.find((entry) => entry.id === query.get('group')) ?? SETTING_GROUPS[0];
  const baseline = useRef<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const payload = useResource(() => client.request<SettingsPayload>('/settings'), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!payload.data) return;
    const incoming = Object.fromEntries(payload.data.settings.map((field) => [field.name, String(field.value)]));
    const previous = baseline.current;
    setDraft((current) => mergeSettingDrafts(current, previous, incoming));
    baseline.current = incoming;
    setFieldErrors({});
  }, [payload.data]);

  if (payload.loading && !payload.data) return <><h2>系统设置</h2><Loading loading error={payload.error} /></>;
  if (!payload.data) return <><h2>系统设置</h2><Loading loading={false} error={payload.error} /></>;

  const data = payload.data;
  const fields = data.settings.filter((field) => settingGroup(field.name) === group.id);
  const changed = fields.filter((field) => field.editable && draft[field.name] !== undefined && draft[field.name] !== String(field.value));
  const save = async (): Promise<void> => {
    setNotice(''); setError('');
    // Numbers and text fields travel in one payload, each in its own type: coercing a URL
    // through Number() would turn every text field into a silent no-op.
    const updates: Record<string, number | string> = {};
    const problems: Record<string, string> = {};
    for (const field of fields) {
      if (!field.editable) continue;
      const raw = draft[field.name] ?? '';
      // Text and select fields travel as typed strings: coercing "on" through Number() would
      // silently drop every non-numeric setting instead of saving it.
      if (field.kind === 'text' || field.kind === 'select') {
        if (raw !== String(field.value)) updates[field.name] = raw;
        continue;
      }
      try {
        const value = settingNumber(raw, field.minimum, field.maximum);
        if (value !== field.value) updates[field.name] = value;
      } catch (caught) { problems[field.name] = message(caught); }
    }
    setFieldErrors(problems);
    if (Object.keys(problems).length) { setError('请修正标记的设置项；本次没有保存任何改动。'); return; }
    if (!Object.keys(updates).length) { setNotice('没有需要保存的改动。'); return; }
    setSaving(true);
    try {
      await client.request('/settings', { settings: updates }, { idempotencyKey: adminIdempotencyKey('settings') });
      // Submitted values can be normalized by the server (for example trimmed paths).
      // Mark only these drafts as submitted so the refresh adopts their effective values.
      baseline.current = { ...baseline.current, ...Object.fromEntries(fields.filter((field) => field.name in updates).map((field) => [field.name, draft[field.name] ?? ''])) };
      setNotice(`已保存 ${group.label}：${fields.filter((field) => field.name in updates).map((field) => field.label).join('、')}。生效值刷新后可核对。`);
      payload.reload();
    } catch (caught) {
      setError(message(caught));
    } finally { setSaving(false); }
  };

  return (
    <>
      <h2>系统设置</h2>
      <Loading loading={payload.loading} error={payload.error} stale={payload.stale} loadedAt={payload.loadedAt} />
      {role !== 'owner' ? <Notice>只有服务器所有者可以修改设置；这里显示的是当前生效值。</Notice> : null}

      <div role="tablist" aria-label="设置分组" style={{ ...row, marginBottom: 16 }}>
        {SETTING_GROUPS.map((entry) => <Button key={entry.id} role="tab" aria-selected={group.id === entry.id} disabled={saving}
          onClick={() => { setError(''); setNotice(''); navigate('/settings?group=' + entry.id); }}>{entry.label}</Button>)}
      </div>
      <p>{group.description}</p>
      <Panel title={group.label} note="环境变量优先于数据库设置；来源为“环境变量”的项不能在页面上修改。">
        <div className="zc-admin-savebar" style={{ ...row, marginTop: 10 }}>
          <Button disabled={saving || payload.loading || payload.stale || !changed.length || role !== 'owner'} onClick={() => { void save(); }}>{saving ? '正在保存…' : '保存本组设置'}</Button>
          <Button disabled={saving} onClick={() => {
            setDraft((current) => ({ ...current, ...Object.fromEntries(fields.map((field) => [field.name, String(field.value)])) }));
            setFieldErrors({}); setError(''); setNotice('已放弃本组改动。');
          }}>放弃本组改动</Button>
          <Button disabled={saving} onClick={payload.reload}>刷新生效值</Button>
        </div>
        <div className="zc-admin-settings-fields">
          {fields.map((field) => <div className="zc-admin-setting" key={field.name}>
            <div>
              <label htmlFor={'setting-' + field.name} style={{ fontWeight: 'var(--fw-medium)' }}>{field.label}</label>
              <p id={'setting-help-' + field.name} style={muted}>{field.description}</p>
              <div className="zc-admin-setting-reference">
                <p style={muted}>默认：{field.defaultValue === undefined ? '未提供' : field.defaultValue === '' ? '空' : String(field.defaultValue)}；
                  范围：{field.kind === 'number' ? String(field.minimum ?? '') + '–' + String(field.maximum ?? '') : field.kind === 'text' ? textRange(field.textFormat, field.maxLength) : (field.options ?? []).map((option) => selectLabel(field.name, option)).join('、')}</p>
              </div>
            </div>
            <div>
              {field.kind === 'select' ? <Select
                id={'setting-' + field.name} aria-label={field.label} aria-describedby={'setting-help-' + field.name}
                value={draft[field.name] ?? String(field.value)} disabled={saving || !field.editable || role !== 'owner'}
                onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}>
                {(field.options ?? []).map((option) => <option key={option} value={option}>{selectLabel(field.name, option)}</option>)}
              </Select> : <TextInput
                id={'setting-' + field.name} aria-label={field.label} aria-invalid={Boolean(fieldErrors[field.name])}
                aria-describedby={'setting-help-' + field.name + (fieldErrors[field.name] ? ' setting-error-' + field.name : '')}
                value={draft[field.name] ?? String(field.value)} disabled={saving || !field.editable || role !== 'owner'}
                onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}
                placeholder={field.kind === 'text' ? textPlaceholder(field.textFormat) : undefined}
                style={{ width: '100%' }} />}
              {fieldErrors[field.name] ? <div id={'setting-error-' + field.name} role="alert" style={{ color: 'var(--negative)' }}>{fieldErrors[field.name]}</div> : null}
              <p style={{ ...muted, margin: '6px 0 0', overflowWrap: 'anywhere' }}>
                <Badge tone="muted">{field.source === 'env' ? '由部署配置管理' : field.source === 'database' ? '已保存设置' : '默认值'}</Badge>
                {field.source === 'env' ? <span> {field.envVar} 覆盖此项，需在部署环境修改</span> : null}
              </p>
            </div>
          </div>)}
        </div>
        {changed.length ? <div aria-label="本组变更预览" style={{ marginTop: 12 }}>
          <strong>将修改 {changed.length} 项</strong>
          <ul>{changed.map((field) => <li key={field.name}>{field.label}：{String(field.value) || '空'} → {draft[field.name] || '空'}</li>)}</ul>
        </div> : <p style={muted}>本组没有未保存的修改。</p>}

        {notice ? <Notice>{notice}</Notice> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </Panel>

      <div className="zc-admin-deployment">
      <Panel title="版本与安全设置">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Stat label="服务版本" value={data.version.server} hint={`数据 schema ${data.version.schema}`} />
          <Stat label="访问令牌有效期" value={`${data.security.accessTokenMinutes} 分钟`} />
          <Stat label="会话有效期" value={`${data.security.sessionDays} 天`} />
          <Stat label="同步服务" value={String(data.environment['syncEnabled'])} />
          <Stat label="Web 服务" value={String(data.environment['webEnabled'])} />
          <Stat label="强制 HTTPS" value={data.environment['httpsRequired'] ? '是' : '否（显式允许明文 HTTP）'} />
        </div>
      </Panel>

      <Panel title="密钥状态" note="密钥只显示是否已配置，页面不返回密钥本身，也不提供读取用户密钥的入口。">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {Object.entries(data.secrets).map(([key, value]) => <li key={key}>{key}：{value === 'configured' ? '已配置' : '未配置'}</li>)}
        </ul>
      </Panel>

      <Panel title="运行环境">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>数据目录：<code>{String(data.environment['dataDir'])}</code></li>
          <li>数据库文件：<code>{String(data.environment['databaseFile'])}</code></li>
          <li>基础路径：{String(data.environment['basePath'] || '/')}</li>
          <li>注册策略：{String(data.environment['registrationMode'])}</li>
          <li>账号保护：{String(data.environment['accountProtection'])}</li>
          <li>托管密钥：{data.environment['custodyEnabled'] ? '启用' : '未启用'}</li>
        </ul>
        {role === 'owner' ? <Field label="注册策略（在“注册与邀请”页修改）"><Select disabled><option>{String(data.environment['registrationMode'])}</option></Select></Field> : null}
      </Panel>
      </div>
    </>
  );
}

/** Select values are stored as short tokens; the label is what an operator reads. */
function selectLabel(name: string, option: string): string {
  const labels: Record<string, string> = { on: '开启', off: '关闭' };
  return labels[option] ?? option;
}

/**
 * A text field is not necessarily a URL.
 *
 * The settings table used to describe every text field as "http(s) 地址", which is right for the
 * webhook and wrong for the channel list (a JSON array) and for a backup path or maintenance
 * window (free text). Telling an operator to enter an address they cannot enter is worse than
 * saying nothing.
 */
function textRange(format: string | undefined, maxLength: number | undefined): string {
  const limit = `最多 ${maxLength ?? 500} 字符`;
  if (format === 'json') return `JSON 数组，${limit}`;
  if (format === 'free') return `自由文本，${limit}`;
  return `http(s) 地址，${limit}`;
}

function textPlaceholder(format: string | undefined): string {
  if (format === 'json') return '留空表示不通知';
  if (format === 'free') return '留空表示未配置';
  return '留空表示不通知';
}
