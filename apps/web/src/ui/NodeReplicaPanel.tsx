import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildSyncBaseUrl, type SyncConnection } from '../sync-config.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { assertNodeReplicaIdentity } from '../node-replica-identity.js';
import { inspectReplicaGroup, invalidateReplicaGroupCertificate,
  type ReplicaGroupInspection } from '../node-replica-routing.js';
import { btnOutline, btnPrimary } from './styles.js';

interface NodeLink {
  linkId: string;
  ledgerId: string;
  peerNodeId: string;
  peerUrl: string;
  grantId: string;
  pullSeq: number;
  pushSeq: number;
  pullBlobCursor: string;
  pushBlobCursor: string;
  pullStateCursor: string;
  pushStateCursor: string;
  peerHeadSeq: number;
  localHeadSeq: number;
  peerBlobObjects: number;
  localBlobObjects: number;
  peerBlobBytes: number;
  localBlobBytes: number;
  pullBlobScannedBytes: number;
  pushBlobScannedBytes: number;
  pullBlobTransferredBytes: number;
  pushBlobTransferredBytes: number;
  peerLegacyObjects: number;
  localLegacyObjects: number;
  peerTombstones: number;
  localTombstones: number;
  pullBlobSweepAt?: string;
  pushBlobSweepAt?: string;
  pullStateSweepAt?: string;
  pushStateSweepAt?: string;
  inventoryMatchedAt?: string;
  inventoryIssue?: string;
  inventoryBlobHash?: string;
  physicalBlobHash?: string;
  physicalVerifiedAt?: string;
  physicalScannedAt?: string;
  physicalIssue?: string;
  lastSuccessAt?: string;
  lastError?: string;
  syncRounds: number;
  convergedRounds: number;
  partialRounds: number;
  failedRounds: number;
  lastRoundDurationMs: number;
  enabled: boolean;
  revocationPending: boolean;
  remoteRevokedAt?: string;
  revocationError?: string;
  lifecycleState: 'JOINING' | 'BOOTSTRAPPING' | 'CATCHING_UP' | 'VERIFYING' | 'READY'
    | 'REVOKING' | 'REVOKED' | 'STOPPED';
  lifecycleCheckedAt?: string;
}

const LIFECYCLE_LABEL: Record<NodeLink['lifecycleState'], string> = {
  JOINING: '正在加入', BOOTSTRAPPING: '建立副本中', CATCHING_UP: '追赶中',
  VERIFYING: '核验中', READY: '本链路已就绪', REVOKING: '授权撤销中',
  REVOKED: '授权已撤销', STOPPED: '本地已停用，远端状态未知',
};

interface NodeGrant {
  grantId: string;
  ledgerId: string;
  peerNodeId: string;
  expiresAt: string;
  renewable: boolean;
}

interface ReplicaPhysicalStatus {
  blobHash?: string;
  verifiedAt?: string;
  scannedAt?: string;
  issue?: string;
}

interface ReplicaReadinessView {
  state: 'BOOTSTRAPPING' | 'CATCHING_UP' | 'VERIFYING' | 'READY';
  issues: string[];
  checkedAt?: string;
  commitCount?: number;
  promisedBlobCount?: number;
  missingPromisedBlobCount?: number;
}

interface ReplicaGroupHealthView {
  state: 'NOT_CONFIGURED' | ReplicaReadinessView['state'];
  coordinatorNodeId: string;
  memberCount: number;
  readyCount: number;
  issues: string[];
  members: { nodeId: string; state: string; receivedAt?: string; issue?: string }[];
}

function formatBytes(value: number): string {
  const safe = Number.isFinite(value) && value >= 0 ? value : 0;
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, safe)) / Math.log(1024)));
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(safe / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

async function serverRequest<T>(profile: SyncConnection, path: string, init: RequestInit = {}): Promise<T> {
  const token = await authenticateSyncProfile(profile);
  const response = await fetch(`${buildSyncBaseUrl(profile)}${path}`, {
    ...init, redirect: 'error', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await response.json().catch(() => ({})) as T & { code?: string; error?: string };
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`),
    { code: body.code, status: response.status });
  return body;
}

async function nodeHealth(profile: SyncConnection): Promise<{ serverId: string; nodePublicKey: string }> {
  await authenticateSyncProfile(profile);
  const response = await fetch(`${buildSyncBaseUrl(profile)}/api/health`, { redirect: 'error' });
  if (!response.ok) throw new Error(`${profile.alias} 健康检查失败`);
  const value = await response.json() as { serverId: string; nodePublicKey: string };
  assertNodeReplicaIdentity(profile, value);
  return value;
}

interface NodeReplicaPanelProps {
  profiles: SyncConnection[];
  ledgerId?: string;
  pinNodeIdentity: (id: string, nodePublicKey: string) => void;
  onConfigureServers: () => void;
}

export function NodeReplicaPanel(props: NodeReplicaPanelProps) {
  const [group, setGroup] = useState<{ joined: boolean; memberCount?: number } | null>();
  const profile = props.profiles.find((item) => item.enabled && item.serverId);
  useEffect(() => {
    if (!profile) { setGroup(null); return; }
    let active = true;
    setGroup(undefined);
    void serverRequest<{ joined: boolean; memberCount?: number }>(profile, '/api/v4/group/status')
      .then((result) => { if (active) setGroup(result); })
      .catch(() => { if (active) setGroup(null); });
    return () => { active = false; };
  }, [profile?.id, profile?.serverId]);
  if (group === undefined) return <p role="status">正在读取服务器同步组状态…</p>;
  if (group?.joined) return <section aria-label="服务器同步组"
    style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 14, marginBottom: 16 }}>
    <strong>服务器同步组已启用</strong>
    <p>组内 {group.memberCount ?? 1} 台服务器会自动同步账本和附件。节点加入与管理请前往管理后台的“系统设置 → 服务器同步组”。</p>
  </section>;
  return <LegacyNodeReplicaPanel {...props} />;
}

function LegacyNodeReplicaPanel({ profiles, ledgerId, pinNodeIdentity, onConfigureServers }: NodeReplicaPanelProps) {
  const groupProfiles = useMemo(() => profiles.filter((profile) => profile.enabled
    && profile.serverId && profile.ledgerId === ledgerId), [profiles, ledgerId]);
  const eligible = profiles.filter((profile) => profile.serverId
    && (profile.ledgerId === ledgerId && profile.enabled || !profile.ledgerId
      || profile.role === 'owner' || profile.role === 'admin'));
  const sourceCandidates = eligible.filter((profile) => profile.ledgerId === ledgerId);
  const [targetId, setTargetId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [links, setLinks] = useState<NodeLink[]>([]);
  const [transferRates, setTransferRates] = useState<Record<string, { pull: number; push: number }>>({});
  const transferSamples = useRef<Record<string, { pull: number; push: number; at: number }>>({});
  const [grants, setGrants] = useState<NodeGrant[]>([]);
  const [sourcePhysical, setSourcePhysical] = useState<ReplicaPhysicalStatus>();
  const [readiness, setReadiness] = useState<Record<string, ReplicaReadinessView>>({});
  const [groupHealth, setGroupHealth] = useState<ReplicaGroupHealthView>();
  const [groupHealthError, setGroupHealthError] = useState('');
  const [manageableGroupMembers, setManageableGroupMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [autoRenew, setAutoRenew] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [group, setGroup] = useState<ReplicaGroupInspection>();
  const [groupChecking, setGroupChecking] = useState(false);
  const [pendingIdentity, setPendingIdentity] = useState<{
    sourceId: string; targetId: string; sourceKey: string; targetKey: string;
  }>();
  const target = eligible.find((profile) => profile.id === targetId)
    ?? eligible.find((profile) => profile.ledgerId !== ledgerId) ?? eligible[0];
  const source = sourceCandidates.find((profile) => profile.id === sourceId && profile.id !== target?.id)
    ?? sourceCandidates.find((profile) => profile.id !== target?.id);
  const healthProfile = source?.ledgerId === ledgerId ? source
    : target?.ledgerId === ledgerId ? target : undefined;

  const refresh = useCallback(async () => {
    if (!target) { setLinks([]); setGrants([]); setSourcePhysical(undefined); setTransferRates({}); transferSamples.current = {}; return; }
    try {
      const [linkResponse, grantResponse, sourceReplica] = await Promise.all([
        serverRequest<{ links: NodeLink[] }>(target, '/api/v4/replication/links'),
        source ? serverRequest<{ grants: NodeGrant[] }>(source, '/api/v4/replication/grants')
          : Promise.resolve({ grants: [] as NodeGrant[] }),
        source ? serverRequest<{ physical?: ReplicaPhysicalStatus }>(source, '/api/v3/replica')
          : Promise.resolve({ physical: undefined }),
      ]);
      const relevantLinks = linkResponse.links.filter((link) => link.ledgerId === ledgerId);
      const at = Date.now();
      const nextSamples: typeof transferSamples.current = {};
      const nextRates: typeof transferRates = {};
      for (const link of relevantLinks) {
        const previous = transferSamples.current[link.linkId];
        nextSamples[link.linkId] = { pull: link.pullBlobTransferredBytes,
          push: link.pushBlobTransferredBytes, at };
        if (previous && at - previous.at >= 1_000) {
          const seconds = (at - previous.at) / 1_000;
          nextRates[link.linkId] = {
            pull: Math.max(0, link.pullBlobTransferredBytes - previous.pull) / seconds,
            push: Math.max(0, link.pushBlobTransferredBytes - previous.push) / seconds,
          };
        }
      }
      transferSamples.current = nextSamples;
      setTransferRates(nextRates);
      setLinks(relevantLinks);
      setGrants(grantResponse.grants.filter((grant) => grant.ledgerId === ledgerId));
      setSourcePhysical(sourceReplica.physical);
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [target, source, ledgerId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      void refresh().finally(() => { inFlight = false; });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const refreshReadiness = useCallback(async () => {
    const candidates = [source, target].filter((profile): profile is SyncConnection =>
      Boolean(profile && profile.ledgerId === ledgerId));
    const rows = await Promise.all(candidates.map(async (profile) => {
      try {
        return [profile.id, await serverRequest<ReplicaReadinessView>(profile,
          '/api/v4/ledger/readiness')] as const;
      } catch (cause) {
        return [profile.id, { state: 'VERIFYING' as const,
          issues: [`状态读取失败：${cause instanceof Error ? cause.message : String(cause)}`] }] as const;
      }
    }));
    setReadiness(Object.fromEntries(rows));
    const healthSource = healthProfile;
    if (healthSource && ledgerId && healthSource.ledgerId === ledgerId) {
      try {
        setGroupHealth(await serverRequest<ReplicaGroupHealthView>(healthSource, '/api/v4/ledger/group-health'));
        setGroupHealthError('');
        try {
          const result = await serverRequest<{ members: { nodeId: string; retiredAt?: string }[] }>(
            healthSource, '/api/v4/ledger/group-members');
          setManageableGroupMembers(result.members.filter((member) => !member.retiredAt)
            .map((member) => member.nodeId));
        } catch { setManageableGroupMembers([]); }
      } catch (cause) {
        setGroupHealth(undefined);
        setGroupHealthError(cause instanceof Error ? cause.message : String(cause));
        setManageableGroupMembers([]);
      }
    } else { setGroupHealth(undefined); setGroupHealthError(''); setManageableGroupMembers([]); }
  }, [source, target, ledgerId, healthProfile]);
  useEffect(() => { void refreshReadiness(); }, [refreshReadiness]);
  useEffect(() => {
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      void refreshReadiness().finally(() => { inFlight = false; });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshReadiness]);
  const refreshGroup = useCallback(async () => {
    if (!ledgerId || groupProfiles.length < 2) { setGroup(undefined); return; }
    setGroupChecking(true);
    try { setGroup(await inspectReplicaGroup(groupProfiles, ledgerId)); }
    finally { setGroupChecking(false); }
  }, [groupProfiles, ledgerId]);
  useEffect(() => { void refreshGroup(); }, [refreshGroup]);

  const join = async () => {
    if (!target || !source || !ledgerId || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    let grantId: string | undefined;
    try {
      const [targetHealth, sourceHealth, targetReplica, sourceReplica] = await Promise.all([
        nodeHealth(target), nodeHealth(source),
        serverRequest<{ bound: boolean; ledgerId?: string }>(target, '/api/v3/replica'),
        serverRequest<{ bound: boolean; ledgerId?: string }>(source, '/api/v3/replica'),
      ]);
      if (sourceReplica.ledgerId !== ledgerId) throw new Error('源节点账本不匹配');
      const useExistingReplica = targetReplica.bound && targetReplica.ledgerId === ledgerId;
      if (!source.nodePublicKey || !target.nodePublicKey) {
        if (!pendingIdentity || pendingIdentity.sourceId !== source.id || pendingIdentity.targetId !== target.id
          || pendingIdentity.sourceKey !== sourceHealth.nodePublicKey
          || pendingIdentity.targetKey !== targetHealth.nodePublicKey) {
          setPendingIdentity({ sourceId: source.id, targetId: target.id,
            sourceKey: sourceHealth.nodePublicKey, targetKey: targetHealth.nodePublicKey });
          setNotice('请在两台服务器本机核对节点签名公钥，再点击“确认身份并建立复制”。');
          return;
        }
        if (!source.nodePublicKey) pinNodeIdentity(source.id, sourceHealth.nodePublicKey);
        if (!target.nodePublicKey) pinNodeIdentity(target.id, targetHealth.nodePublicKey);
      }
      setPendingIdentity(undefined);
      const grant = await serverRequest<{ grantId: string }>(source, '/api/v4/replication/grants', {
        method: 'POST', body: JSON.stringify({ peerNodeId: targetHealth.serverId, peerPublicKey: targetHealth.nodePublicKey,
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), renewable: autoRenew }),
      });
      grantId = grant.grantId;
      const current = await serverRequest<{ links: NodeLink[] }>(target, '/api/v4/replication/links');
      const existing = current.links.find((link) => link.ledgerId === ledgerId && link.peerNodeId === sourceHealth.serverId);
      if (existing) {
        await serverRequest(target, `/api/v4/replication/links/${existing.linkId}/grant`, {
          method: 'PUT', body: JSON.stringify({ grantId }),
        });
      } else {
        await serverRequest(target, useExistingReplica ? '/api/v4/replication/links' : '/api/v4/replication/join', {
          method: 'POST', body: JSON.stringify({ peerUrl: buildSyncBaseUrl(source), peerNodeId: sourceHealth.serverId,
            peerPublicKey: sourceHealth.nodePublicKey, grantId, ledgerId }),
        });
      }
      grantId = undefined;
      invalidateReplicaGroupCertificate(ledgerId);
      setNotice(existing ? '复制授权已续签，后台会继续使用原链路和游标。'
        : `${target.alias} 已加入 ${source.alias} 的后台双向复制。${useExistingReplica ? '' : '已为源节点统一账号建立独立账本账号。'}关闭浏览器后服务器仍会继续。`);
      await refresh();
      void refreshReadiness();
      void refreshGroup();
    } catch (cause) {
      if (grantId) await serverRequest(source, `/api/v4/replication/grants/${grantId}`, { method: 'DELETE' }).catch(() => undefined);
      setPendingIdentity(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const disable = async (linkId: string) => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await serverRequest(target, `/api/v4/replication/links/${linkId}`, { method: 'DELETE' });
      if (ledgerId) invalidateReplicaGroupCertificate(ledgerId);
      await refresh();
      void refreshReadiness();
      void refreshGroup();
      setNotice('本地复制已停止；节点将在后台撤销源节点授权，离线时持续重试。此节点仍在副本组中，须明确移出才不再计入整组健康。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const rescan = async (linkId: string) => {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      await serverRequest(target, `/api/v4/replication/links/${linkId}/rescan`, { method: 'POST' });
      if (ledgerId) invalidateReplicaGroupCertificate(ledgerId);
      await refresh();
      void refreshReadiness();
      void refreshGroup();
      setNotice('已从头重扫这条链路的提交、附件、成员和删除状态；节点会在后台核对并补传缺失内容，原账本数据及授权保留。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const revokeGrant = async (grantId: string) => {
    if (!source || busy) return;
    setBusy(true);
    try {
      await serverRequest(source, `/api/v4/replication/grants/${grantId}`, { method: 'DELETE' });
      if (ledgerId) invalidateReplicaGroupCertificate(ledgerId);
      await refresh();
      void refreshReadiness();
      setNotice('源节点复制授权已撤销；该节点仍在副本组中并显示未就绪，须明确移出。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const retireGroupMember = async (nodeId: string) => {
    if (!source || busy || !globalThis.confirm(`确认将 ${nodeId} 移出此账本副本组并撤销它的复制授权？请先停止在该节点记账并核对同步状态；节点上的旧数据不会被自动删除。`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const path = `/api/v4/ledger/group-members/${encodeURIComponent(nodeId)}`;
      let unverified = false;
      try {
        await serverRequest(source, path, { method: 'DELETE' });
      } catch (cause) {
        if ((cause as { code?: string }).code !== 'GROUP_MEMBER_NOT_VERIFIED') throw cause;
        const entered = globalThis.prompt(`${cause instanceof Error ? cause.message : '副本状态未核实'}\n\n` +
          `移出后可能无法再获取 ${nodeId} 上尚未同步的账目或附件。确认承担此风险，请输入完整节点 ID：`, '');
        if (entered !== nodeId) {
          setNotice('已取消移出副本组；请先检查目标节点与本节点的副本状态。');
          return;
        }
        await serverRequest(source, path, { method: 'DELETE',
          body: JSON.stringify({ nodeId, confirmUnverifiedRemoval: true }) });
        unverified = true;
      }
      if (ledgerId) invalidateReplicaGroupCertificate(ledgerId);
      await refresh();
      await refreshReadiness();
      void refreshGroup();
      setNotice(`${nodeId} 已移出副本组，其复制授权已撤销；旧节点数据仍需单独处理。${unverified
        ? '移出时副本未通过完整核对，请保留该节点直到确认没有独有的账目或附件。' : ''}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <section aria-label="账本副本" style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 14, marginBottom: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexWrap: 'wrap', gap: 8 }}>
      <div style={{ fontWeight: 'var(--fw-bold)' }}>账本副本</div>
      <button type="button" style={btnOutline} onClick={onConfigureServers}>配置节点连接</button>
    </div>
    {groupProfiles.length >= 2 && <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
      padding: 10, marginTop: 10, marginBottom: 12 }}>
      <div style={{ fontWeight: 'var(--fw-bold)' }}>
        当前配置 {groupProfiles.length} 个节点 · {groupChecking ? '正在核对' : group?.ready
          ? '已核对为同一可互换副本组' : '副本组尚未通过完整核对'}
      </div>
      {group?.nodes.map((node) => <div key={node.profileId} style={{ fontSize: 'var(--fs-caption)',
        color: node.topology?.readinessState === 'READY' && !node.error ? 'var(--positive)' : 'var(--text-tertiary)' }}>
        {node.alias} · {node.error ? `无法核对：${node.error}` : node.topology?.readinessState}
        {node.topology?.commitCount !== undefined ? ` · 提交 ${node.topology.commitCount}` : ''}
        {node.topology?.promisedBlobCount !== undefined ? ` · 承诺附件 ${node.topology.promisedBlobCount}` : ''}
        {node.topology?.missingPromisedBlobCount ? ` · 缺失 ${node.topology.missingPromisedBlobCount}` : ''}
        {node.topology?.readinessIssues?.length ? ` · ${node.topology.readinessIssues.join('；')}` : ''}
      </div>)}
      <button type="button" style={btnOutline} disabled={groupChecking} onClick={() => void refreshGroup()}>核对全部节点</button>
    </div>}
    <div style={{ fontWeight: 'var(--fw-bold)' }}>服务器后台复制</div>
    <details style={{ marginBottom: 12 }}>
      <summary style={{ cursor: 'pointer', color: 'var(--accent)', fontSize: 'var(--fs-caption)' }}>了解复制与核对方式</summary>
    <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', lineHeight: 1.6 }}>
      选择一台尚无此账本副本、且由节点管理员登录的服务器。管理员已有其他账本也可以加入；系统会为源节点统一账号创建独立账本账号，节点管理员不会因此获得此账本访问权。获授权的直连节点同步账号密码凭据，源节点暂时不可达时，凭据已复制的账号仍可在目标节点登录。托管账本在目标节点接收并重新封存密钥后可直接打开；私密账本仍需恢复码，成员账本仍需成员密钥密码。创建后由服务器复制提交和新版附件，浏览器关闭也会继续。勾选自动续期后，有效节点活动会延长授权；停止链路后节点会持续尝试撤销源节点授权。旧版附件仍需客户端迁移。本节点 READY 与中继汇总的授权副本组状态分别显示；网页配置的可互换节点组仍需逐台核对。
    </p>
    </details>
    <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
      <label>加入节点<br /><select className="zc-select" value={target?.id ?? ''} onChange={(event) => setTargetId(event.target.value)}>
        {eligible.map((profile) => <option key={profile.id} value={profile.id}>{profile.alias}</option>)}
      </select></label>
      <label>中继节点<br /><select className="zc-select" value={source?.id ?? ''} onChange={(event) => setSourceId(event.target.value)}>
        {sourceCandidates.filter((profile) => profile.id !== target?.id).map((profile) => <option key={profile.id} value={profile.id}>{profile.alias}</option>)}
      </select></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={autoRenew} onChange={(event) => setAutoRenew(event.target.checked)} />
        活动时自动续期
      </label>
      <button type="button" style={btnPrimary} disabled={busy || !target || !source || !ledgerId} onClick={() => void join()}>
        {busy ? '处理中…' : pendingIdentity && source?.id === pendingIdentity.sourceId
          && target?.id === pendingIdentity.targetId ? '确认身份并建立复制' : '建立 / 续签复制'}
      </button>
      <button type="button" style={btnOutline} disabled={busy || !target} onClick={() => {
        void refresh();
        void refreshReadiness();
        void refreshGroup();
      }}>刷新状态</button>
    </div>
    {eligible.length < 2 && <p style={{ color: 'var(--text-tertiary)' }}>请先登录源账本和目标服务器的节点管理员账号。</p>}
    {pendingIdentity && source?.id === pendingIdentity.sourceId && target?.id === pendingIdentity.targetId &&
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 10, marginTop: 10,
        fontSize: 'var(--fs-caption)', overflowWrap: 'anywhere' }}>
        <div>在各服务器本机读取 <code>/api/health</code> 的 <code>nodePublicKey</code>，核对后再建立复制：</div>
        <div>{source.alias}（{source.serverId}）：<code>{pendingIdentity.sourceKey}</code></div>
        <div>{target.alias}（{target.serverId}）：<code>{pendingIdentity.targetKey}</code></div>
      </div>}
    {error && <p role="alert" style={{ color: 'var(--negative)' }}>{error}</p>}
    {notice && <p style={{ color: 'var(--positive)' }}>{notice}</p>}
    {source && <div style={{ color: sourcePhysical?.issue ? 'var(--negative)' : 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>
      {source.alias} 本地附件校验：{sourcePhysical?.issue ?? (sourcePhysical?.verifiedAt
        ? `通过（${new Date(sourcePhysical.verifiedAt).toLocaleString()}）` : '等待首次扫描或重新校验')}
    </div>}
    {[source, target].filter((profile): profile is SyncConnection => Boolean(profile && readiness[profile.id]))
      .map((profile) => <div key={`readiness-${profile.id}`} style={{ color: readiness[profile.id]?.state === 'READY'
        ? 'var(--positive)' : 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', lineHeight: 1.6 }}>
        {profile.alias} 本节点副本：<strong>{readiness[profile.id]?.state}</strong>
        {readiness[profile.id]?.issues.length ? ` · ${readiness[profile.id]!.issues.join('；')}` : ' · 当前证据已核对'}
      </div>)}
    {healthProfile && groupHealth && <div style={{ borderTop: '1px solid var(--border)', marginTop: 12,
      paddingTop: 10, fontSize: 'var(--fs-caption)', lineHeight: 1.6 }}>
      <strong>{healthProfile.alias} 看到的副本组：</strong> {groupHealth.state} ·
      {` ${groupHealth.readyCount}/${groupHealth.memberCount} 节点就绪`}
      {groupHealth.issues.length ? ` · ${groupHealth.issues.join('；')}` : ' · 报告与目录均通过当前核对'}
      {groupHealth.members.map((member) => <div key={member.nodeId} style={{ color: member.state === 'READY'
        ? 'var(--positive)' : 'var(--text-tertiary)' }}>
        {member.nodeId} · {member.state}{member.issue ? ` · ${member.issue}` : ''}
        {member.receivedAt ? ` · 最近报告 ${new Date(member.receivedAt).toLocaleString()}` : ''}
        {manageableGroupMembers.includes(member.nodeId) && member.nodeId !== groupHealth.coordinatorNodeId &&
          <button type="button" style={{ ...btnOutline, marginLeft: 8 }} disabled={busy}
            onClick={() => void retireGroupMember(member.nodeId)}>移出副本组</button>}
      </div>)}
    </div>}
    {healthProfile && groupHealthError && <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)' }}>
      {healthProfile.alias} 整组状态读取失败：{groupHealthError}
    </div>}
    {links.filter((link) => link.enabled).map((link) => <div key={link.linkId} style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 10 }}>
      <div><strong>{link.peerNodeId}</strong> · {link.peerUrl} · {LIFECYCLE_LABEL[link.lifecycleState]}</div>
      <div style={{ color: link.lastError ? 'var(--negative)' : 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', overflowWrap: 'anywhere' }}>
        {link.lastError ? `复制失败：${link.lastError}`
          : link.pullSeq < link.peerHeadSeq || link.pushSeq < link.localHeadSeq ? '提交追赶中'
            : !link.pullStateSweepAt || !link.pushStateSweepAt || link.pullStateCursor || link.pushStateCursor
              ? '删除与恢复状态核对中'
              : link.peerTombstones !== link.localTombstones ? '删除与恢复状态传播中'
            : !link.pullBlobSweepAt || !link.pushBlobSweepAt || link.pullBlobCursor || link.pushBlobCursor ? '附件核对中'
              : link.peerBlobObjects !== link.localBlobObjects ? '附件补齐中'
              : link.peerLegacyObjects || link.localLegacyObjects ? '旧版附件待迁移'
                : link.inventoryIssue ? link.inventoryIssue
                  : !link.inventoryMatchedAt ? '账本目录摘要核对中'
                    : link.physicalIssue ? link.physicalIssue
                      : !link.physicalVerifiedAt || link.physicalBlobHash !== link.inventoryBlobHash
                        ? '账本目录一致，本地新版附件分块校验中'
                        : '账本目录及本地新版附件分块已校验；请以本节点综合状态确认完整性'}
        {link.lastSuccessAt ? ` · 最近成功 ${new Date(link.lastSuccessAt).toLocaleString()}` : ''}
        {` · 完整轮次 ${link.syncRounds ?? 0}（已就绪 ${link.convergedRounds ?? 0}、追赶中 ${link.partialRounds ?? 0}、失败 ${link.failedRounds ?? 0}）`}
        {link.syncRounds ? ` · 最近一轮 ${(link.lastRoundDurationMs / 1000).toFixed(1)} 秒` : ''}
        {link.inventoryMatchedAt ? ` · 上次目录一致 ${new Date(link.inventoryMatchedAt).toLocaleString()}` : ''}
        {link.physicalVerifiedAt ? ` · 上次本地分块校验 ${new Date(link.physicalVerifiedAt).toLocaleString()}` : ''}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--accent)', fontSize: 'var(--fs-caption)' }}>查看传输明细</summary>
      <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>
        提交拉取 {link.pullSeq}/{link.peerHeadSeq} · 推送 {link.pushSeq}/{link.localHeadSeq}；
        新版附件：对端 {link.peerBlobObjects}、本地 {link.localBlobObjects}；
        密文容量：对端 {formatBytes(link.peerBlobBytes)}、本地 {formatBytes(link.localBlobBytes)}；
        本轮已核对：拉取 {formatBytes(link.pullBlobScannedBytes)}/{formatBytes(link.peerBlobBytes)}、推送 {formatBytes(link.pushBlobScannedBytes)}/{formatBytes(link.localBlobBytes)}；
        已记录分块累计传输：拉取 {formatBytes(link.pullBlobTransferredBytes)}、推送 {formatBytes(link.pushBlobTransferredBytes)}；
        {transferRates[link.linkId] ? `最近刷新间隔平均速度：拉取 ${formatBytes(transferRates[link.linkId]?.pull ?? 0)}/秒、推送 ${formatBytes(transferRates[link.linkId]?.push ?? 0)}/秒；` : ''}
        删除标记：对端 {link.peerTombstones}、本地 {link.localTombstones}；
        旧版附件：对端 {link.peerLegacyObjects}、本地 {link.localLegacyObjects}
      </div>
      <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', marginTop: 4 }}>
        页面打开时约每 3 秒刷新；大附件按块、小附件按页记录进度。累计量包含失败后的重试，不代表剩余字节数。
      </div>
      </details>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button type="button" style={btnOutline} disabled={busy} onClick={() => void rescan(link.linkId)}>重扫并补传</button>
        <button type="button" style={btnOutline} disabled={busy} onClick={() => void disable(link.linkId)}>停止这条链路</button>
      </div>
    </div>)}
    {links.filter((link) => !link.enabled).map((link) => <div key={link.linkId}
      style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 10,
        color: link.revocationPending ? 'var(--negative)' : 'var(--text-tertiary)' }}>
      <strong>{link.peerNodeId}</strong> · {LIFECYCLE_LABEL[link.lifecycleState]} · {link.revocationPending
        ? `源节点授权撤销待确认${link.revocationError ? `：${link.revocationError}` : '，后台会重试'}`
        : link.remoteRevokedAt ? `源节点已确认撤销（${new Date(link.remoteRevokedAt).toLocaleString()}）`
          : '旧链路，远端撤销状态未知'}
    </div>)}
    {grants.length > 0 && <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 10 }}>
      <div style={{ fontWeight: 'var(--fw-bold)' }}>源节点有效授权</div>
      {grants.map((grant) => <div key={grant.grantId} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span>{grant.peerNodeId} · {grant.renewable ? '活动时自动续期' : `到期 ${new Date(grant.expiresAt).toLocaleString()}`}</span>
        <button type="button" style={btnOutline} disabled={busy} onClick={() => void revokeGrant(grant.grantId)}>撤销授权</button>
      </div>)}
    </div>}
  </section>;
}
