/** One user, everything needed to act: account, capacity, sessions, sync, history. */
import type { AdminClient } from './client.js';
import { userSupport } from './operations.js';
import { adminIdempotencyKey } from './idempotency.js';
import { AccountActions, RoleNote } from './AccountActions.js';
import { PasswordResetIssuer } from './PasswordResetIssuer.js';
import { PageHeader, Badge, Button, CopyValue, DataTable, Loading, Notice, Panel, PanelIndex, sectionId, Stat, bytes, canEditAccountQuota, canManageAccount, canWrite, message, muted, quotaLimit, roleLabel, row, useActionError, useResource, when } from './ui.js';
import { SYNC_CATEGORIES, type AccountDetail, type SessionRow } from './types.js';

const sessionState = (session: SessionRow) => session.revokedAt ? '已撤销' : session.active ? '有效' : '已过期';

export function UserDetailPage({ client, accountId, role, navigate, onChanged, selfAccountId }: {
  client: AdminClient;
  accountId: string;
  role: string;
  navigate: (to: string) => void;
  onChanged: () => void;
  selfAccountId: string;
}) {
  const detail = useResource(() => client.request<AccountDetail>(`/accounts/${encodeURIComponent(accountId)}`), [accountId]);
  const actionError = useActionError();
  const reload = () => { detail.reload(); onChanged(); };

  if (detail.loading && !detail.data) return <><h2>用户详情</h2><Loading loading error={detail.error} /></>;
  if (!detail.data) {
    return (
      <>
        <h2>用户详情</h2>
        <PanelIndex sections={[
          { id: sectionId('账号信息'), label: '账号信息' },
          { id: sectionId('设备与会话'), label: '设备与会话' },
          { id: sectionId('同步情况'), label: '同步情况' },
          { id: sectionId('操作记录'), label: '操作记录' },
        ]} />
        <Loading loading={false} error={detail.error} />
        <Button onClick={() => navigate('/users')}>返回用户列表</Button>
      </>
    );
  }

  const { account, capacity, sessions, sync, audit, jobs } = detail.data;
  const support = userSupport(detail.data);
  // A read-only operator never gets a write control, whatever the target's role is.
  const writable = canWrite(role);
  const canManage = canManageAccount(role, account.role);
  // Quota changes are additive and reversible, so owners may also retune their own account.
  const canEditQuota = canEditAccountQuota(role, account.role);
  // Owners and administrators keep control of their own devices; the current session ends
  // through logout, and the server additionally requires a recent login for this.
  const currentSessionId = client.currentSessionId();
  const canRevokeSession = (session: SessionRow): boolean => writable && Boolean(session.active)
    && session.id !== currentSessionId
    && (canManage || account.accountId === selfAccountId);
  const target = {
    accountId: account.accountId, username: account.username, role: account.role, revision: account.version,
    disabled: account.disabled, commitBytes: capacity.commitBytes, commitQuotaBytes: capacity.commitQuotaBytes,
    activeDeviceCount: detail.data.activeSessionCount,
    blobQuotaOwnerUsername: capacity.blobQuotaOwnerUsername,
  };

  return (
    <>
      <PageHeader title={'用户详情 · ' + account.username} actions={
        <>
          <Button onClick={() => navigate(`/preview?username=${encodeURIComponent(account.username)}`)}>预览记账数据</Button>
          <Button onClick={() => navigate('/users')}>返回用户列表</Button>
        </>
      } />
      <Loading loading={detail.loading} error={detail.error} stale={detail.stale} loadedAt={detail.loadedAt} />

      <div className="zc-admin-user-workspace">
      <Panel title="处理该用户">
        <AccountActions client={client} target={target} canManage={canManage} canEditQuota={canEditQuota} onDone={reload} />
        {canManage ? <div style={{ marginTop: 12 }}><PasswordResetIssuer client={client} accountId={account.accountId} username={account.username} onDone={reload} /></div> : null}
      </Panel>
      <Panel title="用户支持摘要" note="先核对账号与最近请求，再查看相关记录。没有同步记录或长期离线，不等于同步失败。">
        <div className="zc-admin-grid">
          <Stat label="账号访问" value={account.disabled ? '已停用' : '已启用'} tone={account.disabled ? 'warn' : undefined} hint="设备登录是否有效，请查看设备与会话" />
          <Stat label="最近同步请求" value={support.sync} tone={support.latest?.outcome === 'error' ? 'bad' : undefined}
            hint={support.latest ? `${when(support.latest.at)} · ${support.latest.resultCode ?? support.latest.operation}` : '服务器尚未记录到该用户的同步请求'} />
          <Stat label="容量" value={support.quotaExceeded ? '已达到配额' : '当前未达到配额'} tone={support.quotaExceeded ? 'warn' : undefined} hint="提交与附件分别计算；达到上限可能限制继续上传" />
          <Stat label="记账预览" value={account.protection?.mode === 'managed' && capacity.ledgerId ? '托管账本' : '暂不具备条件'} hint={support.preview} />
        </div>
        {support.latest?.outcome === 'error' ? <Notice tone="warn">下一步：{SYNC_CATEGORIES.find((entry) => entry.value === support.latest?.category)?.next ?? '打开该账号的同步诊断，核对失败原因与后续请求。'}</Notice> : null}
      </Panel>

      {/*
        Troubleshooting starts from the account, so every related view is one click away and
        already filtered. The accountId travels as the query and the username only as a label:
        a link stays correct even if the readable name later changes.
      */}
      <Panel title="关联排障" note="从异常追到用户后，用这些入口查这个人相关的同步、日志、会话、审计与任务；筛选会带到目标页并写进 URL，可以直接分享。">
        <div style={row}>
          <Button onClick={() => navigate(`/sync?accountId=${encodeURIComponent(account.accountId)}&username=${encodeURIComponent(account.username)}`)}>该账号的同步诊断</Button>
          <Button onClick={() => navigate(`/logs?accountId=${encodeURIComponent(account.accountId)}&username=${encodeURIComponent(account.username)}`)}>该账号的运行日志</Button>
          <Button onClick={() => navigate(`/sessions?accountId=${encodeURIComponent(account.accountId)}&username=${encodeURIComponent(account.username)}`)}>该账号的会话</Button>
          <Button onClick={() => navigate(`/audit?target=${encodeURIComponent(account.accountId)}`)}>以该账号为目标的管理审计</Button>
          <Button onClick={() => navigate(`/jobs?accountId=${encodeURIComponent(account.accountId)}`)}>该账号的维护任务</Button>
        </div>
      </Panel>

      <Panel title="账号信息">
        <div className="zc-admin-grid zc-admin-detail-stats">
          <Stat label="accountId" value={<span style={row}><code style={{ fontSize: 'var(--fs-sm)' }}>{account.accountId}</code><CopyValue value={account.accountId} /></span>} />
          <Stat label="登录账号" value={account.username} />
          <Stat label="昵称" value={account.displayName || '未设置'} />
          <Stat label="已验证邮箱" value={account.email || '未绑定'} hint={account.emailVerifiedAt ? `验证于 ${when(account.emailVerifiedAt)}` : '由用户在“我的账号”验证'} />
          {account.pendingEmail && <Stat label="待验证邮箱" value={account.pendingEmail} />}
          <Stat label="创建时间" value={when(account.createdAt)} />
          <Stat label="角色" value={roleLabel(account.role)} />
          <Stat label="状态" value={account.disabled ? <Badge tone="bad">已禁用</Badge> : <Badge tone="ok">正常</Badge>} />
          <Stat label="保护模式" value={account.protection ? (account.protection.mode === 'managed' ? '云端托管' : account.protection.mode) : '未设置'}
            hint={account.protection ? `版本 ${account.protection.version}` : '用户尚未设置账本保护'} />
          <Stat label="数据版本" value={String(account.version)} hint="用于并发修改检测" />
          <Stat label="最近登录" value={when(account.lastLoginAt)} />
        </div>
        <RoleNote role={account.role} />
      </Panel>

      <Panel title="容量与配额" note={capacity.quotaNote}>
        <div className="zc-admin-grid zc-admin-detail-stats">
          <Stat label="加密提交用量" value={bytes(capacity.commitBytes)} hint={`上限 ${quotaLimit(capacity.commitQuotaBytes)}`} />
          <Stat label="提交条数" value={String(capacity.commitCount)} hint={`headSeq ${capacity.headSeq}`} />
          <Stat label="附件用量" value={bytes(capacity.blobUsedBytes)} hint={`上限 ${quotaLimit(capacity.blobQuotaBytes)}；对象 ${capacity.blobObjectCount}`} />
          <Stat label="回收站占用" value={bytes(capacity.blobTrashBytes)} hint="计入配额" />
          <Stat label="暂存上传占用" value={bytes(capacity.blobStagingBytes)} hint="计入配额" />
          <Stat label="账本绑定" value={capacity.ledgerId ? <code style={{ fontSize: 'var(--fs-sm)' }}>{capacity.ledgerId.slice(0, 12)}…</code> : '未绑定'} hint={capacity.replicaId ?? ''} />
        </div>
      </Panel>



      <Panel title="设备与会话" note="设备名与客户端信息由客户端上报；不通过 IP 推断地理位置。">
        <DataTable
          columns={[
            { key: 'device', header: '设备名称', render: (session: SessionRow) => session.deviceName },
            { key: 'kind', header: '会话类型', render: (session: SessionRow) => session.kind === 'admin' ? '管理后台' : '记账' },
            { key: 'state', header: '状态', render: (session: SessionRow) => <Badge tone={session.revokedAt ? 'bad' : session.active ? 'ok' : 'muted'}>{sessionState(session)}</Badge> },
            { key: 'created', header: '首次登录', secondary: true, render: (session: SessionRow) => when(session.createdAt) },
            { key: 'seen', header: '最近活动', render: (session: SessionRow) => when(session.lastSeenAt) },
            { key: 'expires', header: '到期时间', secondary: true, render: (session: SessionRow) => when(session.expiresAt) },
            { key: 'ip', header: '来源 IP', secondary: true, render: (session: SessionRow) => session.lastIp ?? '暂无数据' },
            {
              key: 'actions', header: '操作', render: (session: SessionRow) => (
                <Button disabled={!canRevokeSession(session)} title={session.id === currentSessionId ? '当前会话请用顶部「退出管理后台」结束' : undefined} onClick={() => {
                  void client.request(`/sessions/${session.id}/revoke`, {}, { idempotencyKey: adminIdempotencyKey(`revoke-${session.id}`) })
                    .then(reload)
                    .catch((error) => actionError.setError(message(error)));
                }}>撤销</Button>
              ),
            },
          ]}
          rows={sessions}
          rowKey={(session) => session.id}
          empty="该账号还没有登录过。"
        />
        {actionError.error ? <Notice tone="bad">{actionError.error}</Notice> : null}
      </Panel>

      <Panel title="同步情况">
        {sync.transfer && <div className="zc-admin-grid" style={{ marginBottom: 16 }}>
          <Stat label="完整同步轮次" value={String(sync.transfer.syncRuns)} />
          <Stat label="已收敛轮次" value={String(sync.transfer.convergedRuns)} />
          <Stat label="待续轮次" value={String(sync.transfer.partialRuns)} />
          <Stat label="失败轮次" value={String(sync.transfer.failedRuns)} />
          <Stat label="提交上传请求" value={String(sync.transfer.commitPushRequests)} />
          <Stat label="提交下载请求" value={String(sync.transfer.commitPullRequests)} />
          <Stat label="本站客户端上传" value={bytes(sync.transfer.commitUploadBytes + sync.transfer.blobUploadBytes)} />
          <Stat label="本站客户端下载" value={bytes(sync.transfer.commitDownloadBytes + sync.transfer.blobDownloadBytes)} />
        </div>}
        <p style={muted}>同步轮次由客户端完成后上报到本站；传输流量统计本站已记录的加密正文，重试计入流量。</p>
        <DataTable
          columns={[
            { key: 'at', header: '时间', render: (event) => when(event.at) },
            { key: 'operation', header: '操作', render: (event) => event.operation },
            { key: 'outcome', header: '结果', render: (event) => event.outcome === 'ok' ? <Badge tone="ok">成功</Badge> : <Badge tone="bad">{event.resultCode ?? '失败'}</Badge> },
            { key: 'category', header: '原因', render: (event) => SYNC_CATEGORIES.find((entry) => entry.value === event.category)?.label ?? '暂无数据' },
            { key: 'next', header: '下一步', secondary: true, render: (event) => SYNC_CATEGORIES.find((entry) => entry.value === event.category)?.next ?? '暂无数据' },
            {
              key: 'request', header: '请求 ID', secondary: true, render: (event) => event.requestId ? (
                <button type="button" className="zc-admin-inline-link"
                  onClick={() => navigate(`/logs?requestId=${encodeURIComponent(event.requestId ?? '')}`)}>{event.requestId}</button>
              ) : '暂无数据',
            },
          ]}
          rows={sync.recent}
          rowKey={(event) => event.id}
          empty="暂无同步记录：服务端只记录实际发生的同步请求。"
        />
        <p style={muted}>长时间没有同步不代表故障：用户可能离线或没有新操作。</p>
      </Panel>

      <Panel title="操作记录">
        {audit.length === 0 ? <p style={muted}>该账号暂无管理操作记录。</p> : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {audit.map((entry) => (
              <li key={entry.id} style={{ marginBottom: 6 }}>
                {when(entry.at)} · {entry.action}{entry.reason ? `（原因：${entry.reason}）` : ''}
                {entry.requestId ? (
                  <span style={muted}> · 请求{' '}
                    <button type="button" className="zc-admin-inline-link"
                      onClick={() => navigate(`/logs?requestId=${encodeURIComponent(entry.requestId ?? '')}`)}>{entry.requestId}</button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {jobs.length ? (
          <>
            <strong style={{ display: 'block', marginTop: 10 }}>相关维护任务</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {jobs.map((job) => (
                <li key={job.jobId}>
                  <button type="button" className="zc-admin-inline-link"
                    onClick={() => navigate(`/jobs?job=${encodeURIComponent(job.jobId)}`)}>{job.type}</button>
                  {' '}· {job.status} · {when(job.createdAt)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <Notice>托管账本可通过上方只读预览查看，查看原因会写入审计。这里不显示用户密钥。</Notice>
      </Panel>
      </div>
    </>
  );
}
