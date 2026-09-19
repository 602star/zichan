/**
 * @zichan/core — platform-agnostic data model + lifecycle calculations for the
 * multi-asset lifecycle ledger. No UI, no platform/storage deps: web, desktop,
 * and mobile shells all import from here. See docs/data-model.md.
 */
export * from './types.js';
export * from './category-catalog.js';
export { PLAIN_HTTP_HOST_ALLOWLIST, isPlainHttpHost } from './transport-policy.js';
export { D, Decimal, sum, round, roundD, safeDiv, isZero, eq, type Numeric } from './decimal.js';
export { newId, prefixedId } from './ids.js';
export {
  encryptJson,
  decryptJson,
  createLedgerCryptoSession,
  createLedgerKeyEnvelope,
  wrapLedgerCryptoSession,
  unlockLedgerKeyEnvelope,
  changeLedgerPassphrase,
  rotateLedgerDataKey,
  rotateLedgerProtection,
  normalizeSyncUsername,
  canonicalJson,
  sha256Json,
  sha256Bytes,
  deriveAttachmentCryptoContext,
  attachmentRemoteBlobId,
  encryptAttachmentChunk,
  decryptAttachmentChunk,
  encryptBackupBytes,
  decryptBackupBytes,
  encryptBackupChunk,
  decryptBackupChunk,
  type Encrypted,
  type EncryptedBinary,
  type EncryptedBackupChunk,
  type LedgerKeyEnvelope,
  type LedgerCryptoSession,
  type AttachmentCryptoRoutingContext,
  type AttachmentCryptoContext,
  type EncryptedAttachmentChunk,
} from './crypto.js';
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hasNativeSubtle,
  hmacSha256,
  randomBytes as secureRandomBytes,
} from './crypto-provider.js';
export {
  mergeSyncPayloads,
  syncPayload,
  wireSyncCommit,
  type SyncRevisionV2,
  type SyncRevisionOp,
  type SyncCommitV2,
  type SyncCommitEnvelope,
  type MergeOutcome,
} from './events.js';
export {
  parseDay,
  isValidDay,
  addDays,
  addMonths,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  startOfWeek,
  daysBetween,
  heldDays,
  dayOfInstant,
  hourBucketOfInstant,
  toInstant,
  localToday,
  todayIn,
  dateRangeForPreset,
  isDateInRange,
  isDateRangeValid,
  type DateRange,
  type DateRangePreset,
} from './dates.js';

export {
  normalizeAsOfMode,
  resolveAsOfDate,
  asOfState,
  type AsOfResolutionInput,
  type AsOfState,
} from './as-of.js';

export { normalizeOccurrence, systemTimeZone, type OccurrenceInput, type NormalizedOccurrence } from './time.js';
export { systemClock, fixedClock, type Clock } from './clock.js';
export { money, sumMoney, groupMoney, type Money } from './money.js';

export {
  scheduleOccurrenceDate,
  recurrenceOccurrenceDate,
  assertDcaPlanShape,
  assertDcaExecutionShape,
  assertScheduledExecutionShape,
  dcaOccurrenceDate,
  nextUnhandledDcaOccurrence,
  scheduleExecutionId,
  scheduledTransactionId,
  zonedCalendarNow,
  scheduleOccurrenceIsDue,
  listScheduleOccurrences,
  nextUnhandledScheduleOccurrence,
  type ScheduleOccurrence,
  type CalendarRecurrenceRule,
  type ZonedCalendarNow,
} from './schedule.js';

export {
  type Posting,
  type Balance,
  type BalanceKey,
  postingsFromStep,
  postingsFromChain,
  postingsFromGameRecord,
  gameRecordReportingPostings,
  postingsFromTransaction,
  computeBalances,
  balanceOf,
} from './postings.js';

export {
  type CategorySummary,
  type MonthlyCashFlow,
  type CategoryTrend,
  type TransactionAggregationOptions,
  summarizeByCategory,
  monthlyCashFlow,
  categoryTrend,
  isTransactionActive,
  refundAppliedAmount,
  transactionCashAmount,
  transactionIncomeAmount,
  transactionExpenseAmount,
  assertTransactionShape,
  transactionReportingEffect,
  type TransactionReportingCategoryRow,
  type TransactionReportingEffect,
} from './transaction.js';

export {
  type ChainTrace,
  type ConversionStepAmounts,
  type NormalizeConversionAmountsInput,
  normalizeConversionAmounts,
  assertConversionShape,
  conversionStepAmounts,
  traceChain,
} from './conversion.js';

export {
  type SellMatchInput,
  type SellMatchResult,
  lotFromTrace,
  matchSell,
  remainingCostBasis,
  remainingHoldings,
} from './lots.js';

export {
  type DcaReport,
  type DcaReportRow,
  buildDcaReport,
} from './dca.js';

export {
  type SeasonSummary,
  type SeasonSummaryOptions,
  seasonSummary,
  seasonActivitySummary,
  seasonDays,
} from './game.js';

export {
  type FixedAssetCost,
  type FixedAssetCostOptions,
  type FixedUsageCost,
  type FixedGoalProgress,
  fixedAssetCost,
  fixedUsageTotal,
  fixedUsageUnitLabel,
  fixedGoalProgress,
  fixedConsumableRemaining,
} from './fixed.js';

export {
  type PriceFreshness,
  type ResolvedPrice,
  type ResolveLatestPricesOptions,
  type HoldingPricingStatus,
  type HoldingValue,
  type PortfolioValuation,
  type ValuePortfolioInput,
  resolveLatestPrices,
  latestPrices,
  valuePortfolio,
} from './valuation.js';

export type {
  Query,
  QueryCursor,
  CursorPage,
  Collection,
  AuditBatch,
  AuditSource,
  OperationType,
  OperationLogEntry,
  OperationLogQuery,
  SyncConflictResolution,
  LedgerStore,
} from './storage.js';
export { isDefaultAccount, defaultTransactionAccount, accountBalanceTiming, accountTransactionPostings, accountOpeningPostings, accountChainPostings } from './account-ledger.js';
