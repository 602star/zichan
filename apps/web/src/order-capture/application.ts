import type { PrivateOrderFields } from '../db/local-order-private.js';
import type { ReviewedRedactedImage } from './redaction.js';
import type { ReviewedOrderFields } from './types.js';
import type { FormDraft } from '../db/form-drafts.js';

/** Kept in the current task only; consumers persist private fields separately before applying. */
export interface OrderCaptureApplication {
  fields: ReviewedOrderFields;
  attachment?: ReviewedRedactedImage;
  privateFields?: PrivateOrderFields;
}

/** Legacy unreviewed draft images must not be copied back into ordinary autosave. */
export function protectOrderDraft(draft: FormDraft): { draft: FormDraft; removed: number } {
  const rows = draft.files.attachmentDrafts ?? [];
  const safe = rows.filter((row) => row.contentBlob ? !!row.privacyReview : !!row.id);
  if (safe.length === rows.length) return { draft, removed: 0 };
  const metadata = safe.map(({ contentBlob: _content, thumbnailBlob: _thumbnail, ...row }) => row);
  return { draft: { ...draft, values: { ...draft.values, attachmentDrafts: JSON.stringify(metadata) }, files: { ...draft.files, attachmentDrafts: safe } }, removed: rows.length - safe.length };
}
