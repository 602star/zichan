import type { Setting } from '@zichan/core';

export type TransactionFormOptionalKey =
  | 'timezone'
  | 'payeeId'
  | 'locationId'
  | 'locationName'
  | 'tagIds'
  | 'status'
  | 'note';

export const TRANSACTION_FORM_FIELDS: { key: TransactionFormOptionalKey; label: string; accountsOnly?: boolean }[] = [
  { key: 'timezone', label: '交易时区' },
  { key: 'payeeId', label: '商家 / 平台' },
  { key: 'locationId', label: '地点' },
  { key: 'locationName', label: '地点文本' },
  { key: 'tagIds', label: '标签' },
  { key: 'status', label: '待核实', accountsOnly: true },
  { key: 'note', label: '备注' },
];

export const COMMON_TRANSACTION_FORM_FIELDS: TransactionFormOptionalKey[] = [
  'payeeId', 'locationId', 'locationName', 'tagIds', 'note',
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
  return [...new Set(configured
    .split(',')
    .map((x) => x.trim() === 'merchant' ? 'payeeId' : x.trim())
    .filter((key) => allowed.has(key as TransactionFormOptionalKey)))];
}
