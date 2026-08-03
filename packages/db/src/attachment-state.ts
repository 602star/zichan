import type { SqlDriver } from './driver.js';

export type AttachmentBlobState = 'staging' | 'promoting' | 'ready' | 'missing' | 'trash' | 'quarantined';
export type AttachmentFileOpKind = 'create' | 'replace' | 'import' | 'download' | 'garbage_collect' | 'restore';
export type AttachmentFileOpPhase = 'preparing' | 'prepared' | 'db_committed' | 'promoted' | 'completed' | 'aborted' | 'failed';
export type AttachmentReplicaBlobState = 'missing' | 'queued' | 'uploading' | 'available' | 'downloading' | 'deleting' | 'trash' | 'error';

export interface AttachmentBlobRow {
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  state: AttachmentBlobState;
  verifiedAt?: string;
  lastAccessedAt?: string;
  trashAfter?: string;
  error?: string;
}

export interface AttachmentFileOpRow {
  id: string;
  kind: AttachmentFileOpKind;
  attachmentId?: string;
  contentSha256?: string;
  thumbnailSha256?: string;
  phase: AttachmentFileOpPhase;
  tempContentKey?: string;
  tempThumbnailKey?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface AttachmentReplicaBlobRow {
  profileId: string;
  sha256: string;
  remoteBlobId: string;
  state: AttachmentReplicaBlobState;
  uploadId?: string;
  uploadedChunks?: number[];
  keyVersion: number;
  verifiedAt?: string;
  retryAt?: string;
  updatedAt: string;
  error?: string;
}

function optional(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function blobFromRow(row: Record<string, unknown>): AttachmentBlobRow {
  return {
    sha256: String(row['sha256']),
    sizeBytes: Number(row['size_bytes']),
    mimeType: String(row['mime_type']),
    state: String(row['state']) as AttachmentBlobState,
    verifiedAt: optional(row['verified_at']),
    lastAccessedAt: optional(row['last_accessed_at']),
    trashAfter: optional(row['trash_after']),
    error: optional(row['error']),
  };
}

function opFromRow(row: Record<string, unknown>): AttachmentFileOpRow {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as AttachmentFileOpKind,
    attachmentId: optional(row['attachment_id']),
    contentSha256: optional(row['content_sha256']),
    thumbnailSha256: optional(row['thumbnail_sha256']),
    phase: String(row['phase']) as AttachmentFileOpPhase,
    tempContentKey: optional(row['temp_content_key']),
    tempThumbnailKey: optional(row['temp_thumbnail_key']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    error: optional(row['error']),
  };
}

function replicaFromRow(row: Record<string, unknown>): AttachmentReplicaBlobRow {
  let uploadedChunks: number[] | undefined;
  if (row['uploaded_chunks_json'] != null) {
    const parsed = JSON.parse(String(row['uploaded_chunks_json'])) as unknown;
    if (Array.isArray(parsed)) uploadedChunks = parsed.filter((value): value is number => Number.isSafeInteger(value) && value >= 0);
  }
  return {
    profileId: String(row['profile_id']),
    sha256: String(row['sha256']),
    remoteBlobId: String(row['remote_blob_id']),
    state: String(row['state']) as AttachmentReplicaBlobState,
    uploadId: optional(row['upload_id']),
    uploadedChunks,
    keyVersion: Number(row['key_version']),
    verifiedAt: optional(row['verified_at']),
    retryAt: optional(row['retry_at']),
    updatedAt: String(row['updated_at']),
    error: optional(row['error']),
  };
}

export class AttachmentStateRepository {
  constructor(private readonly driver: SqlDriver) {}

  async getBlob(sha256: string): Promise<AttachmentBlobRow | undefined> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM attachment_blobs WHERE sha256 = ?', [sha256]);
    return row ? blobFromRow(row) : undefined;
  }

  async listBlobs(): Promise<AttachmentBlobRow[]> {
    return (await this.driver.all<Record<string, unknown>>('SELECT * FROM attachment_blobs ORDER BY sha256')).map(blobFromRow);
  }

  async putBlob(row: AttachmentBlobRow): Promise<void> {
    await this.driver.run(
      `INSERT OR REPLACE INTO attachment_blobs
       (sha256, size_bytes, mime_type, state, verified_at, last_accessed_at, trash_after, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.sha256, row.sizeBytes, row.mimeType, row.state, row.verifiedAt ?? null, row.lastAccessedAt ?? null, row.trashAfter ?? null, row.error ?? null],
    );
  }

  async removeBlob(sha256: string): Promise<void> {
    await this.driver.run('DELETE FROM attachment_blobs WHERE sha256 = ?', [sha256]);
  }

  async getFileOp(id: string): Promise<AttachmentFileOpRow | undefined> {
    const row = await this.driver.get<Record<string, unknown>>('SELECT * FROM attachment_file_ops WHERE id = ?', [id]);
    return row ? opFromRow(row) : undefined;
  }

  async listFileOps(phases?: AttachmentFileOpPhase[]): Promise<AttachmentFileOpRow[]> {
    if (!phases?.length) {
      return (await this.driver.all<Record<string, unknown>>('SELECT * FROM attachment_file_ops ORDER BY created_at')).map(opFromRow);
    }
    const placeholders = phases.map(() => '?').join(', ');
    return (await this.driver.all<Record<string, unknown>>(
      `SELECT * FROM attachment_file_ops WHERE phase IN (${placeholders}) ORDER BY created_at`,
      phases,
    )).map(opFromRow);
  }

  async putFileOp(row: AttachmentFileOpRow): Promise<void> {
    await this.driver.run(
      `INSERT OR REPLACE INTO attachment_file_ops
       (id, kind, attachment_id, content_sha256, thumbnail_sha256, phase, temp_content_key,
        temp_thumbnail_key, created_at, updated_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.kind, row.attachmentId ?? null, row.contentSha256 ?? null,
        row.thumbnailSha256 ?? null, row.phase, row.tempContentKey ?? null,
        row.tempThumbnailKey ?? null, row.createdAt, row.updatedAt, row.error ?? null,
      ],
    );
  }

  async patchFileOp(id: string, patch: Partial<Pick<AttachmentFileOpRow, 'phase' | 'contentSha256' | 'thumbnailSha256' | 'updatedAt' | 'error'>>): Promise<void> {
    const current = await this.getFileOp(id);
    if (!current) throw new Error(`附件文件操作不存在：${id}`);
    await this.putFileOp({ ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  }

  async getReplicaBlob(profileId: string, sha256: string): Promise<AttachmentReplicaBlobRow | undefined> {
    const row = await this.driver.get<Record<string, unknown>>(
      'SELECT * FROM attachment_replica_blobs WHERE profile_id = ? AND sha256 = ?',
      [profileId, sha256],
    );
    return row ? replicaFromRow(row) : undefined;
  }

  async listReplicaBlobs(profileId?: string): Promise<AttachmentReplicaBlobRow[]> {
    const rows = profileId
      ? await this.driver.all<Record<string, unknown>>('SELECT * FROM attachment_replica_blobs WHERE profile_id = ? ORDER BY sha256', [profileId])
      : await this.driver.all<Record<string, unknown>>('SELECT * FROM attachment_replica_blobs ORDER BY profile_id, sha256');
    return rows.map(replicaFromRow);
  }

  async putReplicaBlob(row: AttachmentReplicaBlobRow): Promise<void> {
    await this.driver.run(
      `INSERT OR REPLACE INTO attachment_replica_blobs
       (profile_id, sha256, remote_blob_id, state, upload_id, uploaded_chunks_json, key_version,
        verified_at, retry_at, updated_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.profileId, row.sha256, row.remoteBlobId, row.state, row.uploadId ?? null,
        row.uploadedChunks ? JSON.stringify(row.uploadedChunks) : null, row.keyVersion,
        row.verifiedAt ?? null, row.retryAt ?? null, row.updatedAt, row.error ?? null,
      ],
    );
  }

  async removeReplicaBlobs(profileId: string): Promise<void> {
    await this.driver.run('DELETE FROM attachment_replica_blobs WHERE profile_id = ?', [profileId]);
  }
}
