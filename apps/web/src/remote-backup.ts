import { sha256Bytes, sha256Json } from '@zichan/core';
import { assertSecureSyncUrl } from '@zichan/db';
import {
  readBackupArchiveHeader,
  type BackupArchiveHeader,
} from './db/backup-archive.js';
import { authenticateSyncProfile } from './sync-auth.js';
import { runtimeCredential } from './credential-vault.js';
import {
  buildSyncBaseUrl,
  loadSyncProfiles,
  type SyncServerProfile,
} from './sync-config.js';

const REMOTE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_CHUNKS = 512;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RemoteChunk {
  index: number;
  sizeBytes: number;
  ciphertextSha256: string;
  iv: string;
}

interface RemoteManifest {
  v: 1;
  blobId: string;
  cipherBytes: number;
  chunkCount: number;
  chunks: RemoteChunk[];
}

interface UploadPlan {
  status: 'available' | 'upload';
  uploadId?: string;
  missingChunks: number[];
}

export interface RemoteBackupArchive {
  archiveId: string;
  ledgerId: string;
  blobId: string;
  createdAt: string;
  reason: BackupArchiveHeader['reason'];
  kind: BackupArchiveHeader['kind'];
  label: string;
  sizeBytes: number;
  sourceGeneration?: string;
}

export interface RemoteBackupResult {
  profileId: string;
  alias: string;
  saved: boolean;
  archiveId: string;
  error?: string;
}

function chunkRanges(size: number): { offset: number; length: number }[] {
  if (!Number.isSafeInteger(size) || size < 128) throw new Error('加密备份大小无效');
  const ranges: { offset: number; length: number }[] = [];
  for (let offset = 0; offset < size; offset += REMOTE_CHUNK_BYTES) {
    ranges.push({ offset, length: Math.min(REMOTE_CHUNK_BYTES, size - offset) });
  }
  if (ranges.length > 1 && ranges.at(-1)!.length < 16) {
    const last = ranges.pop()!;
    ranges.at(-1)!.length -= 16 - last.length;
    ranges.push({ offset: size - 16, length: 16 });
  }
  if (ranges.length > MAX_REMOTE_CHUNKS) throw new Error('备份超过同步服务器单个归档的最大分块数');
  return ranges;
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { code?: string; error?: string };
    return new Error(`HTTP ${response.status}${body.code ? ` ${body.code}` : ''}${body.error ? ` ${body.error}` : ''}`);
  } catch {
    return new Error(`HTTP ${response.status}`);
  }
}

class RemoteBackupClient {
  private readonly baseUrl: string;

  constructor(private readonly profile: SyncServerProfile) {
    this.baseUrl = buildSyncBaseUrl(profile);
    assertSecureSyncUrl(this.baseUrl);
  }

  private async request(path: string, init: RequestInit = {}, forceLogin = false): Promise<Response> {
    const token = await authenticateSyncProfile(this.profile, forceLogin);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status === 401 && !forceLogin) return this.request(path, init, true);
    if (!response.ok) throw await responseError(response);
    return response;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request(path, init).then((response) => response.json() as Promise<T>);
  }

  async upload(header: BackupArchiveHeader, archive: Blob): Promise<RemoteBackupArchive> {
    const blobId = await sha256Json({
      format: 'zichan-remote-backup',
      version: 1,
      ledgerId: header.ledgerId,
      archiveId: header.archiveId,
      keyringId: header.keyringId,
    });
    const ranges = chunkRanges(archive.size);
    const chunks: RemoteChunk[] = [];
    for (const [index, range] of ranges.entries()) {
      const bytes = new Uint8Array(await archive.slice(range.offset, range.offset + range.length).arrayBuffer());
      const ciphertextSha256 = await sha256Bytes(bytes);
      chunks.push({
        index,
        sizeBytes: bytes.byteLength,
        ciphertextSha256,
        // The archive is already encrypted internally; this protocol field is
        // catalog metadata. Keep it unique per chunk but stable across retries,
        // because the server requires one canonical manifest for each blobId.
        iv: (await sha256Json({ format: 'zichan-remote-chunk', blobId, index, ciphertextSha256 })).slice(0, 24),
      });
    }
    const manifest: RemoteManifest = {
      v: 1,
      blobId,
      cipherBytes: archive.size,
      chunkCount: chunks.length,
      chunks,
    };
    const plan = await this.json<UploadPlan>('/api/v3/blobs/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    if (plan.status === 'upload') {
      if (!plan.uploadId) throw new Error('同步服务器未返回备份上传会话');
      for (const index of plan.missingChunks) {
        const range = ranges[index];
        if (!range) throw new Error(`同步服务器请求了无效的备份分块 ${index}`);
        const bytes = await archive.slice(range.offset, range.offset + range.length).arrayBuffer();
        await this.request(`/api/v3/blobs/uploads/${plan.uploadId}/chunks/${index}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
      }
      await this.json(`/api/v3/blobs/uploads/${plan.uploadId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
    return (await this.json<{ backup: RemoteBackupArchive }>('/api/v3/backups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archive: {
          archiveId: header.archiveId,
          blobId,
          createdAt: header.createdAt,
          reason: header.reason,
          kind: header.kind,
          label: header.label,
          sizeBytes: archive.size,
          sourceGeneration: header.sourceGeneration,
        },
      }),
    })).backup;
  }

  async list(): Promise<RemoteBackupArchive[]> {
    return (await this.json<{ backups: RemoteBackupArchive[] }>('/api/v3/backups?limit=500')).backups;
  }

  async remove(archiveId: string): Promise<void> {
    await this.request(`/api/v3/backups/${encodeURIComponent(archiveId)}`, { method: 'DELETE' });
  }

  async download(backup: RemoteBackupArchive): Promise<Blob> {
    const manifest = (await this.json<{ manifest: RemoteManifest }>(
      `/api/v3/blobs/${backup.blobId}/manifest`,
    )).manifest;
    if (manifest.blobId !== backup.blobId || manifest.cipherBytes !== backup.sizeBytes
      || manifest.chunkCount !== manifest.chunks.length) {
      throw new Error('同步服务器备份分块清单无效');
    }
    const parts: ArrayBuffer[] = [];
    for (const meta of manifest.chunks) {
      const bytes = new Uint8Array(await (await this.request(
        `/api/v3/blobs/${backup.blobId}/chunks/${meta.index}`,
      )).arrayBuffer());
      if (bytes.byteLength !== meta.sizeBytes || await sha256Bytes(bytes) !== meta.ciphertextSha256) {
        throw new Error(`同步服务器备份分块 ${meta.index} 校验失败`);
      }
      parts.push(bytes.slice().buffer as ArrayBuffer);
    }
    const archive = new Blob(parts, { type: 'application/x-zichan-backup' });
    if (archive.size !== backup.sizeBytes) throw new Error('同步服务器备份下载大小不一致');
    const header = await readBackupArchiveHeader(archive);
    if (header.archiveId !== backup.archiveId
      || header.ledgerId !== backup.ledgerId
      || header.createdAt !== backup.createdAt
      || header.reason !== backup.reason
      || header.kind !== backup.kind
      || header.sourceGeneration !== backup.sourceGeneration) {
      throw new Error('同步服务器备份目录与归档头不一致');
    }
    return archive;
  }
}

function remoteAutoRetention(backups: RemoteBackupArchive[], now = Date.now()): Set<string> {
  const kept = new Set(backups.filter((backup) => backup.reason !== 'auto').map((backup) => backup.archiveId));
  const buckets = new Set<string>();
  let weekly = 0;
  for (const backup of backups.filter((row) => row.reason === 'auto')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    const age = Math.max(0, now - Date.parse(backup.createdAt));
    const date = new Date(backup.createdAt);
    const tier = age < DAY_MS ? 'hourly' : age < 31 * DAY_MS ? 'daily' : 'weekly';
    const key = tier === 'hourly' ? `${tier}:${backup.createdAt.slice(0, 13)}`
      : tier === 'daily' ? `${tier}:${backup.createdAt.slice(0, 10)}`
        : `${tier}:${date.getUTCFullYear()}:${Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 1)) / (7 * DAY_MS))}`;
    if (buckets.has(key) || (tier === 'weekly' && weekly >= 12)) continue;
    buckets.add(key);
    if (tier === 'weekly') weekly += 1;
    kept.add(backup.archiveId);
  }
  return kept;
}

export async function saveEncryptedBackupToSyncServers(
  header: BackupArchiveHeader,
  archive: Blob,
): Promise<RemoteBackupResult[]> {
  const profiles = loadSyncProfiles().filter((profile) =>
    profile.enabled
    && profile.serverId
    && profile.ledgerId === header.ledgerId
    && profile.username.trim()
    && runtimeCredential(profile.id)?.password);
  return Promise.all(profiles.map(async (profile): Promise<RemoteBackupResult> => {
    const client = new RemoteBackupClient(profile);
    try {
      await client.upload(header, archive);
      const backups = await client.list();
      const retained = remoteAutoRetention(backups);
      await Promise.all(backups
        .filter((backup) => backup.reason === 'auto' && !retained.has(backup.archiveId))
        .map((backup) => client.remove(backup.archiveId)));
      return { profileId: profile.id, alias: profile.alias, saved: true, archiveId: header.archiveId };
    } catch (error) {
      return {
        profileId: profile.id,
        alias: profile.alias,
        saved: false,
        archiveId: header.archiveId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export async function listRemoteBackups(profile: SyncServerProfile): Promise<RemoteBackupArchive[]> {
  return new RemoteBackupClient(profile).list();
}

export async function downloadRemoteBackup(
  profile: SyncServerProfile,
  backup: RemoteBackupArchive,
): Promise<Blob> {
  return new RemoteBackupClient(profile).download(backup);
}

export async function removeRemoteBackup(
  profile: SyncServerProfile,
  archiveId: string,
): Promise<void> {
  await new RemoteBackupClient(profile).remove(archiveId);
}
