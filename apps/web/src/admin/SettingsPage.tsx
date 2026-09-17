/** Effective settings: an allow-list, with the source of every value made explicit. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, DataTable, Field, Loading, Notice, Panel, Select, Stat, TextInput, message, muted, row, useResource } from './ui.js';
import type { SettingsPayload } from './types.js';

export function SettingsPage({ client, role }: { client: AdminClient; role: string }) {
  const payload = useResource(() => client.request<SettingsPayload>('/settings'), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!payload.data) return;
    setDraft(Object.fromEntries(payload.data.settings.map((field) => [field.name, String(field.value)])));
  }, [payload.data]);

  if (payload.loading && !payload.data) return <><h2>系统设置</h2><Loading loading error={payload.error} /></>;
  if (!payload.data) return <><h2>系统设置</h2><Loading loading={false} error={payload.error} /></>;

  const data = payload.data;
  const save = async (): Promise<void> => {
    setNotice(''); setError('');
    const updates: Record<string, number> = {};
    for (const field of data.settings) {
      if (!field.editable) continue;
      const value = Number(draft[field.name]);
      if (Number.isFinite(value) && value !== field.value) updates[field.name] = value;
    }
    if (!Object.keys(updates).length) { setNotice('没有需要保存的改动。'); return; }
    try {
      await client.request('/settings', { settings: updates }, { idempotencyKey: adminIdempotencyKey('settings') });
      setNotice(`已保存：${Object.keys(updates).join('、')}`);
      payload.reload();
    } catch (caught) {
      setError(message(caught));
    }
  };

  return (
    <>
      <h2>系统设置</h2>
      <Loading loading={payload.loading} error={payload.error} stale={payload.stale} loadedAt={payload.loadedAt} />
      {role !== 'owner' ? <Notice>只有服务器所有者可以修改设置；这里显示的是当前生效值。</Notice> : null}

      <Panel title="生效配置" note="环境变量优先于数据库设置；来源为“环境变量”的项不能在页面上修改。">
        <DataTable
          columns={[
            { key: 'label', header: '设置项', render: (field) => (
              <span>
                {field.label}
                <div style={muted}>{field.description}</div>
              </span>
            ) },
            {
              key: 'value', header: '生效值', render: (field) => (
                <TextInput
                  value={draft[field.name] ?? String(field.value)}
                  disabled={!field.editable || role !== 'owner'}
                  onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}
                  style={{ width: 120 }}
                />
              ),
            },
            { key: 'source', header: '来源', render: (field) => <Badge tone={field.source === 'env' ? 'warn' : field.source === 'database' ? 'ok' : 'muted'}>{field.source === 'env' ? `环境变量 ${field.envVar}` : field.source === 'database' ? '数据库设置' : '默认值'}</Badge> },
            { key: 'range', header: '允许范围', secondary: true, render: (field) => field.kind === 'number' ? `${field.minimum ?? ''}–${field.maximum ?? ''}` : (field.options ?? []).join('、') },
            { key: 'stored', header: '已保存值', secondary: true, render: (field) => field.stored === null ? '未保存' : String(field.stored) },
          ]}
          rows={data.settings}
          rowKey={(field) => field.name}
          empty="没有可配置项。"
        />
        <div style={{ ...row, marginTop: 10 }}>
          <Button disabled={role !== 'owner'} onClick={() => { void save(); }}>保存允许在线修改的设置</Button>
          <Button onClick={payload.reload}>放弃改动并刷新</Button>
        </div>
        {notice ? <Notice>{notice}</Notice> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </Panel>

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
    </>
  );
}
