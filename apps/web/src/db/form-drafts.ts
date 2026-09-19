import { deleteKv, loadKv, saveKv } from './idb.js';
import type { AttachmentDraftData } from './attachment-storage.js';

const DRAFT_PREFIX = 'form-draft.v1.';

export interface FormDraft {
  version: 1;
  key: string;
  entityVersion?: number;
  manualFieldKeys?: string[];
  savedAt: string;
  values: Record<string, string>;
  files: Record<string, AttachmentDraftData[]>;
}

function storageKey(key: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(key)}`;
}

export function formDraftKey(
  form: string,
  entity?: { id?: unknown; version?: unknown },
): string {
  const id = typeof entity?.id === 'string' && entity.id ? entity.id : 'new';
  return `${form}:${id}`;
}

export async function loadFormDraft(
  key: string,
  entityVersion?: number,
): Promise<FormDraft | null> {
  const draft = await loadKv<FormDraft>(storageKey(key));
  if (!draft || draft.version !== 1 || draft.key !== key) return null;
  if (entityVersion !== undefined && draft.entityVersion !== entityVersion) {
    await deleteFormDraft(key);
    return null;
  }
  return draft;
}

export async function saveFormDraft(
  key: string,
  values: Record<string, string>,
  files: Record<string, AttachmentDraftData[]>,
  entityVersion?: number,
  manualFieldKeys?: string[],
): Promise<FormDraft> {
  const draft: FormDraft = {
    version: 1,
    key,
    entityVersion,
    manualFieldKeys,
    savedAt: new Date().toISOString(),
    values,
    files,
  };
  await saveKv(storageKey(key), draft);
  return draft;
}

export async function deleteFormDraft(key: string): Promise<void> {
  await deleteKv(storageKey(key));
}

export function formDraftFingerprint(
  values: Record<string, string>,
  files: Record<string, AttachmentDraftData[]>,
): string {
  const fileRows = Object.fromEntries(Object.entries(files).map(([key, rows]) => [
    key,
    rows.map((row) => ({
      fileName: row.fileName,
      mimeType: row.mimeType,
      note: row.note,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      thumbnailSha256: row.thumbnailSha256,
      hasContent: !!row.contentBlob,
      hasThumbnail: !!row.thumbnailBlob,
    })),
  ]));
  return JSON.stringify({ values, files: fileRows });
}
