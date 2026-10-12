import { useEffect, useState } from 'react';
import { aggregateKey, fetchAuthMe, loginAccount, mergeReviewedCommit, replayReviewedCommit, requestJson } from '@zichan/db';
import { accountSigningPublicKey, canonicalJson, createAccountEncryptionKey, decryptJson, ledgerControlEventHash, rotateLedgerProtection,
  sha256Json, wireSyncCommit,
  signLedgerControlEvent, unlockAccountEncryptionKey, wrapLedgerCryptoSessionForMember,
  type AccountEncryptionKeyEnvelope, type LedgerControlEvent, type LedgerControlState,
  type LedgerMemberIdentity, type LedgerMemberKeyEnvelope, type LedgerMemberRole, type SyncCommitV2,
  type Encrypted } from '@zichan/core';
import { accountProtection, replaceProtectionRuntime } from '../account-protection.js';
import { commitDeviceStorageRewrap, stageDeviceStorageRewrap } from '../device-storage-key.js';
import { adoptUnlockedLedgerKeyEnvelope, requireLedgerCryptoSession } from '../ledger-key-vault.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { syncConfiguredServers } from '../sync-orchestrator.js';
import { buildSyncBaseUrl, type SyncConnection } from '../sync-config.js';
import { useStore } from '../db/store.js';

interface AccountKeyRecord {
  issuerNodeId: string;
  subjectAccountId: string;
  publicKey: string;
  envelope: AccountEncryptionKeyEnvelope;
}
interface PublicMemberCard extends LedgerMemberIdentity {
  encryptionPublicKey: string;
  signingPublicKey: string;
}
interface View {
  state: LedgerControlState | null;
  actor: LedgerMemberIdentity;
  accountKey: AccountKeyRecord | null;
  envelopes: Map<string, LedgerMemberKeyEnvelope>;
  rejected: { peerNodeId: string; commitId: string; contentHash: string; keyEpoch: number;
    writer?: LedgerMemberIdentity; reason: string; lastSeenAt: string; archived: boolean;
    resolution?: { decision: 'replay' | 'discard'; replacementCommitId?: string } }[];
}

function memberId(value: LedgerMemberIdentity): string {
  return `${value.issuerNodeId}/${value.accountId}`;
}

type ReviewChoice = 'current' | 'rejected';

function changedReviewFields(current: Record<string, unknown>, rejected: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(current), ...Object.keys(rejected)])]
    .filter((field) => JSON.stringify(current[field]) !== JSON.stringify(rejected[field])
      || Object.hasOwn(current, field) !== Object.hasOwn(rejected, field)).sort();
}

function reviewValue(value: unknown): string {
  return value === undefined ? '（无此字段）' : JSON.stringify(value, null, 2);
}

async function api<T>(profile: SyncConnection, path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await authenticateSyncProfile(profile);
  const response = await requestJson(`${buildSyncBaseUrl(profile)}${path}`, {
    method, cache: 'no-store', redirect: 'error', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `账本成员请求失败：HTTP ${response.status}`);
  return result;
}

async function loadView(profile: SyncConnection): Promise<View> {
  const token = await authenticateSyncProfile(profile);
  const me = await fetchAuthMe(buildSyncBaseUrl(profile), token);
  if (me.accountId !== profile.accountId || me.ledgerId !== profile.ledgerId) {
    throw new Error('账号或账本身份已变化');
  }
  const actor = me.federatedIdentity
    ? { issuerNodeId: me.federatedIdentity.issuerNodeId,
      accountId: me.federatedIdentity.subjectAccountId }
    : { issuerNodeId: profile.serverId!, accountId: profile.accountId! };
  const [control, ownKey] = await Promise.all([
    api<{ state: LedgerControlState | null }>(profile, '/api/v4/ledger/control'),
    api<{ record: AccountKeyRecord | null }>(profile, '/api/v4/account/encryption-key'),
  ]);
  const envelopes = new Map<string, LedgerMemberKeyEnvelope>();
  let rejected: View['rejected'] = [];
  const owner = control.state?.members[memberId(actor)];
  if (owner?.removed === false && owner.role === 'OWNER') {
    rejected = (await api<{ commits: View['rejected'] }>(profile,
      '/api/v4/ledger/rejected-commits')).commits;
    let after = '';
    for (let page = 0; page < 10; page += 1) {
      const result = await api<{ envelopes: LedgerMemberKeyEnvelope[]; nextCursor: string; hasMore: boolean }>(
        profile, `/api/v4/ledger/member-envelopes?after=${encodeURIComponent(after)}&limit=10`);
      for (const envelope of result.envelopes) envelopes.set(memberId(envelope), envelope);
      if (!result.hasMore) break;
      if (result.nextCursor <= after) throw new Error('成员密钥列表游标未前进');
      after = result.nextCursor;
      if (page === 9) throw new Error('成员超过当前界面支持的 100 人上限');
    }
  }
  return { state: control.state, actor, accountKey: ownKey.record, envelopes, rejected };
}

function parseCard(input: string): PublicMemberCard {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error('成员身份不是有效 JSON'); }
  if (!value || typeof value !== 'object') throw new Error('成员身份无效');
  const card = value as Partial<PublicMemberCard>;
  if (!card.issuerNodeId || !/^[A-Za-z0-9_-]{8,160}$/.test(card.issuerNodeId)
    || !card.accountId || !/^[A-Za-z0-9_-]{8,160}$/.test(card.accountId)
    || !card.encryptionPublicKey || !card.signingPublicKey) {
    throw new Error('成员身份缺少账号标识或公钥');
  }
  return card as PublicMemberCard;
}

export function LedgerMembersPanel({ profile }: { profile: SyncConnection }) {
  const { store, bump } = useStore();
  const [view, setView] = useState<View>();
  const [password, setPassword] = useState('');
  const [card, setCard] = useState('');
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('EDITOR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewedCommit, setReviewedCommit] = useState<SyncCommitV2>();
  const [reviewedItem, setReviewedItem] = useState<View['rejected'][number]>();
  const [repairConfirmed, setRepairConfirmed] = useState(false);
  const [repairedCommit, setRepairedCommit] = useState<SyncCommitV2>();
  const [reviewedCurrent, setReviewedCurrent] = useState<Record<string, Record<string, unknown> | null>>({});
  const [reviewedHeads, setReviewedHeads] = useState<{
    ledgerHeads: string[]; entityHeads: Record<string, string[]>;
    currentPayloads: Record<string, Record<string, unknown> | null>;
  }>();
  const [wholeReviewChoices, setWholeReviewChoices] = useState<Record<string, ReviewChoice>>({});
  const [fieldReviewChoices, setFieldReviewChoices] = useState<Record<string, Record<string, ReviewChoice>>>({});

  async function refresh() { setView(await loadView(profile)); }
  useEffect(() => {
    let active = true;
    void loadView(profile).then((result) => { if (active) setView(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [profile]);

  async function run(action: () => Promise<void>, message: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); setNotice(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPassword(''); setBusy(false); }
  }

  async function reviewRejected(item: View['rejected'][number]) {
    if (!profile.ledgerId || !item.archived) throw new Error('此隔离提交没有可用密文，请检查发送节点');
    const result = await api<{ commit: { commitId: string; ledgerId: string; contentHash: string;
      encCommit: Encrypted } }>(profile,
    `/api/v4/ledger/rejected-commits/${encodeURIComponent(item.peerNodeId)}/${encodeURIComponent(item.commitId)}`);
    const saved = result.commit;
    if (saved.commitId !== item.commitId || saved.ledgerId !== profile.ledgerId
      || saved.contentHash !== item.contentHash) throw new Error('隔离提交元数据与目录不一致');
    const commit = await decryptJson<SyncCommitV2>(requireLedgerCryptoSession(profile.ledgerId),
      saved.encCommit, { protocol: 2, ledgerId: saved.ledgerId, commitId: saved.commitId,
        contentHash: saved.contentHash });
    if (commit.protocol !== 2 || commit.commitId !== saved.commitId || commit.ledgerId !== saved.ledgerId
      || await sha256Json(commit) !== saved.contentHash) throw new Error('隔离提交内容校验失败');
    const before = await store.syncGraph();
    const currentEntries = await Promise.all(commit.revisions.map(async (revision) => [
      aggregateKey(revision.aggregateType, revision.aggregateId),
      await store.getSyncAggregate(revision.aggregateType, revision.aggregateId),
    ] as const));
    const after = await store.syncGraph();
    const entityHeads = Object.fromEntries(commit.revisions.map((revision) => {
      const key = aggregateKey(revision.aggregateType, revision.aggregateId);
      return [key, before.entityHeads.get(key) ?? []];
    }));
    if (JSON.stringify(before.ledgerHeads) !== JSON.stringify(after.ledgerHeads)
      || Object.entries(entityHeads).some(([key, heads]) => JSON.stringify(heads)
        !== JSON.stringify(after.entityHeads.get(key) ?? []))) {
      throw new Error('读取审核内容期间账本发生变化，请重新同步并核对');
    }
    setRepairConfirmed(false);
    const currentPayloads = Object.fromEntries(currentEntries);
    setReviewedCurrent(currentPayloads);
    setReviewedHeads({ ledgerHeads: before.ledgerHeads, entityHeads, currentPayloads });
    setWholeReviewChoices({});
    setFieldReviewChoices({});
    setReviewedItem(item);
    setRepairedCommit(await store.repairForReviewedCommit(item.commitId));
    setReviewedCommit(commit);
  }

  async function signReviewedDecision(decision: 'replay' | 'discard', repaired?: SyncCommitV2) {
    if (!view || !reviewedItem || !profile.ledgerId || !repairConfirmed) {
      throw new Error('请先解密、核对并确认隔离提交');
    }
    const current = (await api<{ state: LedgerControlState }>(profile, '/api/v4/ledger/control')).state;
    if (current.members[memberId(view.actor)]?.role !== 'OWNER'
      || current.members[memberId(view.actor)]?.removed) throw new Error('当前账号已不是账本所有者');
    const privateKey = await ownerPrivateKey();
    try {
      await postEvent(signLedgerControlEvent(privateKey, {
        v: 1, ledgerId: profile.ledgerId, seq: current.seq + 1,
        previousHash: current.headHash, keyEpoch: current.keyEpoch,
        kind: 'RejectedCommitResolved', actor: view.actor, target: view.actor,
        rejectedCommitId: reviewedItem.commitId, rejectedContentHash: reviewedItem.contentHash,
        decision,
        ...(decision === 'replay' && repaired ? {
          replacementCommitId: repaired.commitId,
          replacementContentHash: await sha256Json(wireSyncCommit(repaired)),
        } : {}),
      }));
    } finally { privateKey.fill(0); }
    setReviewedCommit(undefined);
    setReviewedItem(undefined);
    setRepairedCommit(undefined);
    setReviewedCurrent({});
    setReviewedHeads(undefined);
    setWholeReviewChoices({});
    setFieldReviewChoices({});
    setRepairConfirmed(false);
  }

  async function repairReviewed() {
    if (!reviewedCommit || !reviewedItem || !repairConfirmed) throw new Error('请先核对并确认隔离提交的业务内容');
    let repaired = repairedCommit;
    if (!repaired) {
      const before = await syncConfiguredServers(store, [profile]);
      if (!before.converged) throw new Error('当前账本尚未与此节点收敛，请先完成同步再修复');
      repaired = await replayReviewedCommit(store, reviewedCommit);
      setRepairedCommit(repaired);
      bump();
    }
    const after = await syncConfiguredServers(store, [profile]);
    if (!after.converged) throw new Error(`修复提交 ${repaired.commitId} 已保存在本机，但尚未上传完成；请保留本机数据并重试同步`);
    await signReviewedDecision('replay', repaired);
  }

  function selectedManualPayloads(): Record<string, Record<string, unknown> | null> {
    if (!reviewedCommit?.revisions.length || !reviewedHeads) throw new Error('请先重新核对隔离提交');
    const payloads: Record<string, Record<string, unknown> | null> = {};
    for (const revision of reviewedCommit.revisions) {
      const key = aggregateKey(revision.aggregateType, revision.aggregateId);
      if (!(key in reviewedCurrent) || key in payloads) throw new Error('待合并记录不完整或重复');
      const current = reviewedCurrent[key] ?? null;
      const rejected = revision.op === 'delete' ? null : revision.payload;
      if (!current || !rejected) {
        const choice = wholeReviewChoices[key];
        if (!choice) throw new Error('请为每项记录选择最终版本');
        payloads[key] = choice === 'current' ? current : rejected;
        continue;
      }
      const merged = { ...current };
      for (const field of changedReviewFields(current, rejected)) {
        const choice = fieldReviewChoices[key]?.[field];
        if (!choice) throw new Error(`请为 ${revision.aggregateType} 的 ${field} 选择最终值`);
        const selected = choice === 'current' ? current : rejected;
        if (Object.hasOwn(selected, field)) merged[field] = selected[field];
        else delete merged[field];
      }
      payloads[key] = merged;
    }
    return payloads;
  }

  async function mergeReviewed() {
    if (!reviewedCommit || !reviewedItem || !repairConfirmed || !reviewedHeads || repairedCommit) {
      throw new Error('请先核对并逐项选择隔离提交的合并结果');
    }
    const payloads = selectedManualPayloads();
    const before = await syncConfiguredServers(store, [profile]);
    if (!before.converged) throw new Error('当前账本尚未与此节点收敛，请先完成同步再合并');
    const merged = await mergeReviewedCommit(store, reviewedCommit, payloads, reviewedHeads);
    setRepairedCommit(merged);
    bump();
    const after = await syncConfiguredServers(store, [profile]);
    if (!after.converged) throw new Error(`合并提交 ${merged.commitId} 已保存在本机，但尚未上传完成；请保留本机数据并重试同步`);
    await signReviewedDecision('replay', merged);
  }

  async function discardReviewed() {
    if (repairedCommit) throw new Error('已创建修复提交，不能再放弃原提交');
    await signReviewedDecision('discard');
  }

  async function ensureAccountKey(): Promise<AccountKeyRecord> {
    if (!view || !profile.accountId || !profile.serverId) throw new Error('账号身份尚未准备好');
    if (password.length < 8) throw new Error('请输入账号密码');
    if (view.accountKey) {
      if (view.accountKey.issuerNodeId !== view.actor.issuerNodeId
        || view.accountKey.subjectAccountId !== view.actor.accountId) throw new Error('账号密钥与当前身份不一致');
      return view.accountKey;
    }
    if (view.actor.issuerNodeId !== profile.serverId || view.actor.accountId !== profile.accountId) {
      throw new Error('账号密钥尚未同步。请先在创建账号的网站登录一次，再刷新本站。');
    }
    const baseUrl = buildSyncBaseUrl(profile);
    const verified = await loginAccount(baseUrl, profile.username, password, {
      expectedServerId: profile.serverId, expectedServerPublicKey: profile.serverPublicKey,
      sessionTransport: 'token', deviceName: '验证账本共享账号密码',
    });
    await requestJson(`${baseUrl}/api/auth/logout`, { method: 'POST', cache: 'no-store',
      redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${verified.accessToken}` } });
    const created = await createAccountEncryptionKey(profile.serverId, profile.accountId, password);
    try {
      const record = (await api<{ record: AccountKeyRecord }>(profile,
        '/api/v4/account/encryption-key', 'PUT', { envelope: created.envelope, expectedRevision: 0 })).record;
      if (!record || record.issuerNodeId !== view.actor.issuerNodeId
        || record.subjectAccountId !== view.actor.accountId) throw new Error('账号密钥初始化失败');
      setView((current) => current ? { ...current, accountKey: record } : current);
      return record;
    } finally { created.privateKey.fill(0); }
  }

  async function ownerPrivateKey(accountKey?: AccountKeyRecord): Promise<Uint8Array> {
    if (password.length < 8) throw new Error('请输入账号密码');
    const record = accountKey ?? await ensureAccountKey();
    try { return await unlockAccountEncryptionKey(password, record.envelope); }
    catch { throw new Error('账号密码无法解锁成员管理密钥。旧账号请到账号页迁移独立密钥密码。'); }
  }

  async function postEvent(event: LedgerControlEvent, envelopes?: LedgerMemberKeyEnvelope[]) {
    try {
      await api(profile, '/api/v4/ledger/control/events', 'POST', { event, ...(envelopes ? { envelopes } : {}) });
    } catch (reason) {
      const current = await api<{ state: LedgerControlState }>(profile, '/api/v4/ledger/control')
        .catch(() => undefined);
      if (current?.state?.headHash !== ledgerControlEventHash(event)) throw reason;
      if (envelopes?.length) {
        const observed = await loadView(profile).catch(() => undefined);
        if (!observed || envelopes.some((envelope) => {
          const saved = observed.envelopes.get(memberId(envelope));
          return !saved || canonicalJson(saved) !== canonicalJson(envelope);
        })) throw reason;
      }
    }
  }

  async function initialize(): Promise<View> {
    if (!view || !profile.ledgerId) throw new Error('账本尚未准备好');
    if (view.state) return view;
    const accountKey = await ensureAccountKey();
    const privateKey = await ownerPrivateKey(accountKey);
    try {
      const event = signLedgerControlEvent(privateKey, {
        v: 1, ledgerId: profile.ledgerId, seq: 1, previousHash: null, keyEpoch: 1,
        kind: 'MemberGenesis', actor: view.actor, target: view.actor, role: 'OWNER',
        signingPublicKey: accountSigningPublicKey(privateKey),
        encryptionPublicKey: accountKey.publicKey,
      });
      await api(profile, '/api/v4/ledger/control', 'POST', { event });
      const envelope = await wrapLedgerCryptoSessionForMember(requireLedgerCryptoSession(profile.ledgerId), {
        ...view.actor, recipientPublicKey: accountKey.publicKey, keyEpoch: 1,
      });
      await api(profile, '/api/v4/ledger/member-envelope', 'PUT', { envelope });
    } finally { privateKey.fill(0); }
    const updated = await loadView(profile);
    if (!updated.state) throw new Error('账本共享权限尚未生效，请刷新后重试');
    setView(updated);
    return updated;
  }

  async function issueEnvelope(target: LedgerMemberIdentity) {
    if (!view?.state || !profile.ledgerId) return;
    if (view.envelopes.has(memberId(target))) return;
    const member = view.state.members[memberId(target)];
    if (!member || member.removed) throw new Error('目标不是当前有效成员');
    const envelope = await wrapLedgerCryptoSessionForMember(requireLedgerCryptoSession(profile.ledgerId), {
      ...target, recipientPublicKey: member.encryptionPublicKey, keyEpoch: view.state.keyEpoch,
    });
    await api(profile, '/api/v4/ledger/member-envelope', 'PUT', { envelope });
  }

  async function addMember() {
    if (!view || !profile.ledgerId) return;
    const replica = await api<{ headSeq: number }>(profile, '/api/v3/replica');
    if (!Number.isSafeInteger(replica.headSeq) || replica.headSeq < 1) {
      throw new Error('请先把当前账本同步到此服务器，再邀请成员');
    }
    const target = parseCard(card);
    const current = await initialize();
    const state = current.state!;
    if (state.members[memberId(target)]?.removed === false) throw new Error('此账号已经是账本成员');
    const privateKey = await ownerPrivateKey(current.accountKey ?? undefined);
    try {
      const event = signLedgerControlEvent(privateKey, {
        v: 1, ledgerId: profile.ledgerId, seq: state.seq + 1,
        previousHash: state.headHash, keyEpoch: state.keyEpoch,
        kind: 'MemberAdded', actor: current.actor,
        target: { issuerNodeId: target.issuerNodeId, accountId: target.accountId }, role,
        signingPublicKey: target.signingPublicKey,
        encryptionPublicKey: target.encryptionPublicKey,
      });
      const envelope = await wrapLedgerCryptoSessionForMember(requireLedgerCryptoSession(profile.ledgerId), {
        issuerNodeId: target.issuerNodeId, accountId: target.accountId,
        recipientPublicKey: target.encryptionPublicKey, keyEpoch: state.keyEpoch,
      });
      await postEvent(event, [envelope]);
      setCard('');
    } finally { privateKey.fill(0); }
  }

  async function changeRole(target: LedgerMemberIdentity, nextRole: LedgerMemberRole) {
    if (!view?.state || !profile.ledgerId) return;
    const privateKey = await ownerPrivateKey();
    try { await postEvent(signLedgerControlEvent(privateKey, {
      v: 1, ledgerId: profile.ledgerId, seq: view.state.seq + 1,
      previousHash: view.state.headHash, keyEpoch: view.state.keyEpoch,
      kind: 'MemberRoleChanged', actor: view.actor, target, role: nextRole,
    })); }
    finally { privateKey.fill(0); }
  }

  async function removeMember(target: LedgerMemberIdentity) {
    if (!view?.state || !profile.ledgerId) return;
    const privateKey = await ownerPrivateKey();
    try {
      const current = requireLedgerCryptoSession(profile.ledgerId);
      const rotated = await rotateLedgerProtection(current, password);
      const event = signLedgerControlEvent(privateKey, {
        v: 1, ledgerId: profile.ledgerId, seq: view.state.seq + 1,
        previousHash: view.state.headHash, keyEpoch: view.state.keyEpoch + 1,
        kind: 'MemberRemoved', actor: view.actor, target,
      });
      const survivors = Object.values(view.state.members)
        .filter((member) => !member.removed && memberId(member) !== memberId(target));
      const envelopes = await Promise.all(survivors.map((member) =>
        wrapLedgerCryptoSessionForMember(rotated.session, {
          issuerNodeId: member.issuerNodeId, accountId: member.accountId,
          recipientPublicKey: member.encryptionPublicKey, keyEpoch: view.state!.keyEpoch + 1,
        })));
      await stageDeviceStorageRewrap(password);
      await postEvent(event, envelopes);
      const protection = accountProtection();
      if (!protection || protection.profileId !== profile.id) throw new Error('账本保护会话已改变，请重新登录');
      adoptUnlockedLedgerKeyEnvelope(rotated.envelope, rotated.session, true);
      replaceProtectionRuntime(password, { ...protection.info, mode: 'member', secret: null,
        envelope: rotated.envelope });
      commitDeviceStorageRewrap();
    } finally { privateKey.fill(0); }
  }

  if (!profile.ledgerId) return null;
  const state = view?.state;
  const self = state && view ? state.members[memberId(view.actor)] : undefined;
  const isOwner = !state || self?.removed === false && self.role === 'OWNER';
  const active = state ? Object.values(state.members).filter((member) => !member.removed) : [];
  const unresolved = view?.rejected.filter((item) => !item.resolution) ?? [];
  const manualChoicesComplete = (() => {
    try { selectedManualPayloads(); return true; } catch { return false; }
  })();
  return <details className="zc-card" aria-label="账本共享">
    <summary>账本共享{state ? ` · ${active.length} 人` : ''}</summary>
    <p className="zc-caption">邀请其他账号一起记账，并设置可记账或只读权限。</p>
    <button disabled={busy} onClick={() => void run(refresh, '成员状态已更新')}>刷新</button>
    {view ? <>
      {state ? <p>当前成员 {active.length} 人</p>
        : <p>此账本尚未与其他账号共享。邀请第一位成员时会自动开通。</p>}
      {isOwner && <>
        {view.rejected.length > 0 && <div role="status" style={{ border: '1px solid var(--negative)', padding: 12, marginBottom: 12 }}>
          <strong>有 {unresolved.length} 条节点写入待处理</strong>
          <p>这些旧代次或无效提交未进入当前账本。新收到的密文会限额保存在此节点；请保留发送节点数据与备份，核对业务内容后再重新记账。</p>
          <details><summary>查看隔离记录</summary>
            {view.rejected.map((item) => <p key={`${item.peerNodeId}/${item.commitId}`}>
              节点 {item.peerNodeId} · 提交 {item.commitId} · 密钥代次 {item.keyEpoch}
              {item.writer ? ` · 写入者 ${memberId(item.writer)}` : ''} · {item.reason}
              {' · '}{new Date(item.lastSeenAt).toLocaleString()}
              {item.resolution && ` · 已签名处置：${item.resolution.decision === 'replay' ? `新提交 ${item.resolution.replacementCommitId}` : '放弃原提交'}`}
              {!item.resolution && item.archived && <button disabled={busy} onClick={() => void run(
                () => reviewRejected(item), '隔离提交已解密并校验，请核对内容')}>查看待审核内容</button>}
              {!item.resolution && !item.archived && ' · 密文未归档，请检查发送节点'}
            </p>)}
          </details>
          {reviewedCommit && <details open><summary>已校验的隔离提交 {reviewedCommit.commitId}</summary>
            <p>请逐项核对。相关记录未变化时可直接重放；已变化时逐字段选择最终值，再生成新的合并提交。</p>
            <pre style={{ maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(reviewedCommit, null, 2)}</pre>
            {!repairedCommit && <details><summary>手动合并已变化的记录</summary>
              {reviewedCommit.revisions.map((revision) => {
                const key = aggregateKey(revision.aggregateType, revision.aggregateId);
                const current = reviewedCurrent[key] ?? null;
                const rejected = revision.op === 'delete' ? null : revision.payload;
                const fields = current && rejected ? changedReviewFields(current, rejected) : [];
                return <div key={key} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
                  <strong>{revision.aggregateType} · {revision.aggregateId}</strong>
                  {!current || !rejected ? <>
                    <p>当前与隔离提交存在新增或删除差异，请选择整项结果。</p>
                    <select className="zc-select" aria-label={`${revision.aggregateType} ${revision.aggregateId} 最终版本`}
                      value={wholeReviewChoices[key] ?? ''}
                      onChange={(event) => setWholeReviewChoices((value) => ({ ...value,
                        [key]: event.target.value as ReviewChoice }))}>
                      <option value="">选择最终版本</option><option value="current">保留当前</option>
                      <option value="rejected">采用隔离提交</option>
                    </select>
                    <div>当前：<pre style={{ maxHeight: 140, overflow: 'auto' }}>{reviewValue(current)}</pre></div>
                    <div>隔离提交：<pre style={{ maxHeight: 140, overflow: 'auto' }}>{reviewValue(rejected)}</pre></div>
                  </> : fields.length ? fields.map((field) => <div key={field} style={{ marginTop: 10 }}>
                    <strong>{field}</strong>
                    <select className="zc-select" aria-label={`${revision.aggregateType} ${revision.aggregateId} ${field} 最终值`}
                      value={fieldReviewChoices[key]?.[field] ?? ''}
                      onChange={(event) => setFieldReviewChoices((value) => ({ ...value,
                        [key]: { ...(value[key] ?? {}), [field]: event.target.value as ReviewChoice } }))}>
                      <option value="">选择最终值</option><option value="current">保留当前</option>
                      <option value="rejected">采用隔离提交</option>
                    </select>
                    <div>当前：<pre style={{ maxHeight: 140, overflow: 'auto' }}>{reviewValue(current[field])}</pre></div>
                    <div>隔离提交：<pre style={{ maxHeight: 140, overflow: 'auto' }}>{reviewValue(rejected[field])}</pre></div>
                  </div>) : <p>该记录的字段值相同，无需逐字段选择。</p>}
                </div>;
              })}
              <p>合并会以当前账本为基础创建新提交。若审核期间账本变化，系统会要求重新核对。</p>
              <button disabled={busy || !repairConfirmed || !manualChoicesComplete || password.length < 8}
                onClick={() => void run(mergeReviewed, '已签名记录手动合并决定，节点将在后台收敛')}>
                创建手动合并提交并签名处置</button>
            </details>}
            <label><input type="checkbox" checked={repairConfirmed} onChange={(event) => setRepairConfirmed(event.target.checked)} />
              我已核对上述业务内容，并确认选择处置方式</label>
            <button disabled={busy || !repairConfirmed || password.length < 8}
              onClick={() => void run(repairReviewed, '已签名记录修复决定，节点将在后台收敛')}>
              {repairedCommit ? '继续上传并签名处置' : '创建修复提交并签名处置'}</button>
            {!repairedCommit && <button disabled={busy || !repairConfirmed || password.length < 8}
              onClick={() => void run(discardReviewed, '已签名放弃原提交，节点将在后台收敛')}>
              放弃此原提交</button>}
            {repairedCommit && <p>本机修复提交：{repairedCommit.commitId}。签名处置前请保留本机数据。</p>}
          </details>}
        </div>}
        <label>账号密码<input aria-label="成员管理账号密码" type="password" autoComplete="current-password"
          value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {state && active.map((member) => <div key={memberId(member)} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
              <strong>{memberId(member)}</strong> · {member.role}
              {!view.envelopes.has(memberId(member)) && <button disabled={busy} onClick={() => void run(() => issueEnvelope(member), '成员密钥已发放')}>补发密钥</button>}
              {memberId(member) !== memberId(view.actor) && <>
                <button disabled={busy || password.length < 8} onClick={() => void run(() => changeRole(member,
                  member.role === 'VIEWER' ? 'EDITOR' : 'VIEWER'), '成员角色已更新')}>
                  改为{member.role === 'VIEWER' ? '可记账' : '只读'}</button>
                <button disabled={busy || password.length < 8} onClick={() => void run(() => removeMember(member),
                  '成员已移除，账本密钥已轮换')}>移除并轮换密钥</button>
              </>}
            </div>)}
            <details><summary>邀请成员</summary>
              <p>让对方从账号页复制成员身份信息。加入后，对方可用自己的账号密码打开此账本。</p>
              <textarea aria-label="待邀请成员身份" value={card} onChange={(event) => setCard(event.target.value)}
                style={{ width: '100%', minHeight: 130 }} />
              <label>权限<select value={role} onChange={(event) => setRole(event.target.value as 'EDITOR' | 'VIEWER')}>
                <option value="EDITOR">可记账</option><option value="VIEWER">只读</option>
              </select></label>
              <button disabled={busy || password.length < 8 || !card.trim()}
                onClick={() => void run(addMember, '成员已加入账本')}>加入账本</button>
            </details>
      </>}
      {!isOwner && state && <div>{active.map((member) => <p key={memberId(member)}>{memberId(member)} · {member.role}</p>)}</div>}
    </> : <p role="status">正在读取成员权限…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
