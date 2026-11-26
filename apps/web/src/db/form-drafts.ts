import { deleteKv, loadKv, saveKv, openIdb } from './idb.js';
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

/** Read only draft keys; attachment/database values never need to be enumerated. */
export async function listFormDrafts(baseKey: string): Promise<FormDraft[]> {
  const db = await openIdb();
  let keys: IDBValidKey[];
  try {
    const prefix = storageKey(baseKey);
    keys = await new Promise((resolve, reject) => {
      const request = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
  const names = keys.filter((key): key is string => typeof key === 'string').map((key) => decodeURIComponent(key.slice(DRAFT_PREFIX.length)))
    .filter((key) => key === baseKey || key.startsWith(`${baseKey}:session:`));
  const rows = await Promise.all(names.map((key) => loadFormDraft(key)));
  return rows.filter((row): row is FormDraft => !!row).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
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
