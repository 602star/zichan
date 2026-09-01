import type { Setting } from '@zichan/core';

export type TransactionFormOptionalKey =
  | 'timezone'
  | 'payeeId'
  | 'merchant'
  | 'locationId'
  | 'locationName'
  | 'tagIds'
  | 'accountId'
  | 'transferAssetId'
  | 'transferAccountId'
  | 'transferAmount'
  | 'status'
  | 'refundForId'
  | 'refundAppliedAmount'
  | 'note';

export const TRANSACTION_FORM_FIELDS: { key: TransactionFormOptionalKey; label: string; accountsOnly?: boolean }[] = [
  { key: 'timezone', label: '交易时区' },
  { key: 'payeeId', label: '已有商户' },
  { key: 'merchant', label: '新商户名称' },
  { key: 'locationId', label: '地点' },
  { key: 'locationName', label: '地点文本' },
  { key: 'tagIds', label: '标签' },
  { key: 'accountId', label: '账户', accountsOnly: true },
  { key: 'transferAssetId', label: '转入币种', accountsOnly: true },
  { key: 'transferAccountId', label: '转入账户', accountsOnly: true },
  { key: 'transferAmount', label: '转入金额', accountsOnly: true },
  { key: 'status', label: '状态', accountsOnly: true },
  { key: 'refundForId', label: '退款关联原支出' },
  { key: 'refundAppliedAmount', label: '冲减原消费金额' },
  { key: 'note', label: '备注' },
];

export const COMMON_TRANSACTION_FORM_FIELDS: TransactionFormOptionalKey[] = [
  'payeeId', 'merchant', 'locationId', 'locationName', 'tagIds', 'note',
];

export function transactionFormFieldOptions(usesAccounts: boolean) {
  return TRANSACTION_FORM_FIELDS.filter((field) => usesAccounts || !field.accountsOnly);
}

export function transactionFormPresetKeys(preset: 'core' | 'common' | 'full', usesAccounts: boolean): string[] {
  if (preset === 'core') return [];
  const allowed = new Set(transactionFormFieldOptions(usesAccounts).map((field) => field.key));
  if (preset === 'common') return COMMON_TRANSACTION_FORM_FIELDS.filter((key) => allowed.has(key));
  return [...allowed];
}

export function optionalTransactionFields(setting: Setting | undefined, usesAccounts: boolean): string[] {
  const allowed = new Set(transactionFormFieldOptions(usesAccounts).map((field) => field.key));
  const configured = setting?.transactionFormOptionalFields;
  if (configured === undefined) return COMMON_TRANSACTION_FORM_FIELDS.filter((key) => allowed.has(key));
  return configured
    .split(',')
    .map((x) => x.trim())
    .filter((key) => allowed.has(key as TransactionFormOptionalKey));
}
