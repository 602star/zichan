import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncConnection } from '../src/sync-config.js';

vi.mock('../src/sync-auth.js', () => ({ authenticateSyncProfile: vi.fn().mockResolvedValue('test-token') }));

class MemoryStorage implements Storage {
  private readonly rows = new Map<string, string>();
  get length() { return this.rows.size; }
  clear() { this.rows.clear(); }
  getItem(key: string) { return this.rows.get(key) ?? null; }
  key(index: number) { return [...this.rows.keys()][index] ?? null; }
  removeItem(key: string) { this.rows.delete(key); }
  setItem(key: string, value: string) { this.rows.set(key, value); }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  vi.restoreAllMocks();
});

const ledgerId = 'ledger-group-routing-0001';
const at = new Date().toISOString();
const topology = (serverId: string, links: { peerNodeId: string; peerStreamEpoch: string }[] = []) => ({
  serverId, bound: true, ledgerId, replicaId: `replica-${serverId}`,
  streamEpoch: `epoch-${serverId}`, headSeq: 7,
  readinessState: 'READY' as const, readinessCheckedAt: at,
  links: links.map((link) => ({ ...link, localStreamEpoch: `epoch-${serverId}`,
    enabled: true, lastSuccessAt: at, inventoryMatchedAt: at })),
});
const nodes = [topology('hub'), topology('home', [{ peerNodeId: 'hub', peerStreamEpoch: 'epoch-hub' }]),
  topology('office', [{ peerNodeId: 'hub', peerStreamEpoch: 'epoch-hub' }])];
const profile = (nodeId: string): SyncConnection => ({ id: nodeId, serverRef: nodeId, alias: nodeId,
  baseUrl: `https://${nodeId}.example.com`, activeUrl: `https://${nodeId}.example.com`,
  alternateUrls: [], sharedUrls: [], deviceUrls: [], username: 'owner', enabled: true,
  status: 'online', serverId: nodeId, ledgerId, replicaId: `replica-${nodeId}`,
  streamEpoch: `epoch-${nodeId}` });

describe('node replica browser routing', () => {
  it('prefers the node serving the current website', async () => {
    Object.defineProperty(globalThis, 'document', { configurable: true,
      value: { baseURI: 'https://home.example.com/app/' } });
    const { preferredReplicaProfiles } = await import('../src/node-replica-routing.js');
    expect(preferredReplicaProfiles(['hub', 'office', 'home'].map(profile))[0]?.id).toBe('home');
  });

  it('certifies a reconciled hub topology and rejects stale, divergent or disconnected links', async () => {
    const { verifiedReplicaGroup } = await import('../src/node-replica-routing.js');
    expect(verifiedReplicaGroup(nodes, ledgerId)?.nodes.map((node) => node.serverId))
      .toEqual(['home', 'hub', 'office']);
    expect(verifiedReplicaGroup([{ ...nodes[0]!, headSeq: 8 }, nodes[1]!, nodes[2]!], ledgerId)).toBeDefined();
    expect(verifiedReplicaGroup([nodes[0]!, nodes[1]!, { ...nodes[2]!, readinessState: 'VERIFYING' }], ledgerId))
      .toBeUndefined();
    expect(verifiedReplicaGroup([nodes[0]!, nodes[1]!, { ...nodes[2]!, links: [] }], ledgerId)).toBeUndefined();
    expect(verifiedReplicaGroup([nodes[0]!, nodes[1]!, { ...nodes[2]!,
      links: [{ ...nodes[2]!.links[0]!, inventoryIssue: '旧附件待迁移' }] }], ledgerId)).toBeUndefined();
    expect(verifiedReplicaGroup(nodes, ledgerId, Date.now() + 5 * 60_000)).toBeUndefined();
  });

  it('keeps one-node routing through a peer outage and a group membership change', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const id = url.hostname.split('.')[0]!;
      return new Response(JSON.stringify(url.pathname.endsWith('/readiness')
        ? { state: 'READY', checkedAt: at } : nodes.find((node) => node.serverId === id)), { status: 200 });
    });
    const { hasNodeReplicaGroup } = await import('../src/node-replica-routing.js');
    const profiles = ['home', 'hub', 'office'].map(profile);
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(6);
    fetcher.mockRejectedValue(new Error('hub offline'));
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(await hasNodeReplicaGroup([...profiles, profile('fourth')], ledgerId)).toBe(true);
  });

  it('shows live group health even when a previous routing certificate still exists', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const id = url.hostname.split('.')[0]!;
      return new Response(JSON.stringify(url.pathname.endsWith('/readiness')
        ? { state: 'READY', checkedAt: at, issues: [], commitCount: 7,
          promisedBlobCount: 3, missingPromisedBlobCount: 0 }
        : nodes.find((node) => node.serverId === id)), { status: 200 });
    });
    const { hasNodeReplicaGroup, inspectReplicaGroup } = await import('../src/node-replica-routing.js');
    const profiles = ['home', 'hub', 'office'].map(profile);
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    const ready = await inspectReplicaGroup(profiles, ledgerId);
    expect(ready.ready).toBe(true);
    expect(ready.nodes.map((node) => node.topology?.promisedBlobCount)).toEqual([3, 3, 3]);
    fetcher.mockRejectedValue(new Error('node offline'));
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    const offline = await inspectReplicaGroup(profiles, ledgerId);
    expect(offline.ready).toBe(false);
    expect(offline.nodes.map((node) => node.error)).toEqual(['node offline', 'node offline', 'node offline']);
  });

  it('does not restore browser relaying when a certified link was stopped', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    const profiles = ['home', 'hub', 'office'].map(profile);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const id = url.hostname.split('.')[0]!;
      return new Response(JSON.stringify(url.pathname.endsWith('/readiness')
        ? { state: 'READY', checkedAt: at } : nodes.find((node) => node.serverId === id)), { status: 200 });
    });
    const { hasNodeReplicaGroup } = await import('../src/node-replica-routing.js');
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    const later = Date.now() + 3 * 60_000;
    const freshAt = new Date(later).toISOString();
    vi.spyOn(Date, 'now').mockReturnValue(later);
    fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const id = url.hostname.split('.')[0]!;
      const node = nodes.find((item) => item.serverId === id)!;
      return new Response(JSON.stringify(url.pathname.endsWith('/readiness')
        ? { state: 'READY', checkedAt: freshAt }
        : { ...node, links: node.links.map((link) => ({ ...link,
          enabled: id !== 'office', lastSuccessAt: freshAt, inventoryMatchedAt: freshAt })) }),
      { status: 200 });
    });
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    fetcher.mockRejectedValue(new Error('nodes offline'));
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
  });

  it('does not restore browser relaying when a certified node rejects access', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    const profiles = ['home', 'hub', 'office'].map(profile);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const id = url.hostname.split('.')[0]!;
      return new Response(JSON.stringify(url.pathname.endsWith('/readiness')
        ? { state: 'READY', checkedAt: at } : nodes.find((node) => node.serverId === id)), { status: 200 });
    });
    const { hasNodeReplicaGroup } = await import('../src/node-replica-routing.js');
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000);
    fetcher.mockImplementation(async (input) => String(input).includes('office.example.com')
      ? new Response('{}', { status: 403 }) : new Response('{}', { status: 503 }));
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    fetcher.mockRejectedValue(new Error('offline'));
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
  });

  it('uses one node during bootstrap on a browser that has no prior certificate', async () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    const profiles = ['home', 'hub', 'office'].map(profile);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname !== 'home.example.com') throw new Error('peer offline');
      return new Response(JSON.stringify(url.pathname.endsWith('/readiness')
        ? { state: 'VERIFYING', checkedAt: at }
        : { ...nodes[1], serverId: 'home', replicaId: 'replica-home',
          streamEpoch: 'epoch-home', serverManagedReplication: true }), { status: 200 });
    });
    const { hasNodeReplicaGroup } = await import('../src/node-replica-routing.js');
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(6);
    fetcher.mockRejectedValue(new Error('all nodes offline'));
    expect(await hasNodeReplicaGroup(profiles, ledgerId)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
