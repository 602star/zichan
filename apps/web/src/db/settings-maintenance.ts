import type { Attachment, QueryCursor } from '@zichan/core';
import {
  voidTransaction,
  type ConsistencyIssue,
  type SqlLedgerStore,
} from '@zichan/db';
import { verifyAttachmentContent } from './attachment-storage.js';

const MAINTENANCE_PAGE_SIZE = 400;

export type AttachmentContentVerifier = (attachment: Attachment) => Promise<boolean>;

/** Verify every active attachment, including collections larger than one snapshot page. */
export async function checkAllAttachmentFiles(
  store: Pick<SqlLedgerStore, 'attachments'>,
  verify: AttachmentContentVerifier = verifyAttachmentContent,
): Promise<ConsistencyIssue[]> {
  const result: ConsistencyIssue[] = [];
  let cursor: QueryCursor | undefined;
  do {
    const page = await store.attachments.listPage({
      orderBy: 'id',
      limit: MAINTENANCE_PAGE_SIZE,
      cursor,
    });
    for (const attachment of page.rows) {
      try {
        if (!(await verify(attachment))) {
          result.push({
            kind: 'attachment_file_invalid',
            entityType: 'attachment',
            entityId: attachment.id,
            detail: `${attachment.fileName} 的大小或 SHA-256 不一致`,
          });
        }
      } catch (error) {
        result.push({
          kind: 'attachment_file_invalid',
          entityType: 'attachment',
          entityId: attachment.id,
          detail: `${attachment.fileName} 无法读取：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  } while (true);
  return result;
}

/**
 * Void every active test transaction and remove its active attachment metadata
 * in one audited transaction. Child splits remain as part of the voided audit
 * record and therefore cannot affect active reports.
 */
export async function cleanupAllTestTransactions(
  store: SqlLedgerStore,
): Promise<{ transactions: number; attachments: number }> {
  let transactionCount = 0;
  let attachmentCount = 0;
  await store.runInAuditBatch('清理测试流水', async (transactionStore) => {
    let cursor: QueryCursor | undefined;
    do {
      const page = await transactionStore.testTransactionCleanupPage({
        limit: MAINTENANCE_PAGE_SIZE,
        cursor,
      });
      for (const attachment of page.attachments) {
        await transactionStore.attachments.remove(attachment.id, attachment.version);
        attachmentCount += 1;
      }
      for (const transaction of page.transactions) {
        await voidTransaction(transactionStore, transaction.id, '清理测试流水');
        transactionCount += 1;
      }
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    } while (true);
  }, 'bulk_update');
  return { transactions: transactionCount, attachments: attachmentCount };
}
