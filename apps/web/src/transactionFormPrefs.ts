import type { Setting } from '@zichan/core';

export type TransactionFormOptionalKey =
  | 'payeeId'
  | 'locationId'
  | 'locationName'
  | 'tagIds'
  | 'note'
  | 'assetId'
  | 'timezone'
  | 'status'
  | 'orderNumber'
  | 'trackingNumber'
  | 'invoiceNumber'
  | 'invoiceCode'
  | 'invoiceDate';

export type TransactionFormFieldGroupKey = 'daily' | 'ledger' | 'document';

export interface TransactionFormFieldOption {
  key: TransactionFormOptionalKey;
  label: string;
  group: TransactionFormFieldGroupKey;
  accountsOnly?: boolean;
}

export const TRANSACTION_FORM_FIELD_GROUPS: { key: TransactionFormFieldGroupKey; label: string }[] = [
  { key: 'daily', label: '日常补充' },
  { key: 'ledger', label: '币种与记账状态' },
  { key: 'document', label: '单据与发票' },
];

export const TRANSACTION_FORM_FIELDS: TransactionFormFieldOption[] = [
  { key: 'payeeId', label: '商家 / 平台', group: 'daily' },
  { key: 'locationId', label: '地点', group: 'daily' },
  { key: 'tagIds', label: '标签', group: 'daily' },
  { key: 'note', label: '备注', group: 'daily' },
  { key: 'assetId', label: '币种', group: 'ledger' },
  { key: 'timezone', label: '交易时区', group: 'ledger' },
  { key: 'status', label: '待核实', group: 'ledger', accountsOnly: true },
  { key: 'orderNumber', label: '订单号', group: 'document' },
  { key: 'trackingNumber', label: '物流单号', group: 'document' },
  { key: 'invoiceNumber', label: '发票号码', group: 'document' },
  { key: 'invoiceCode', label: '发票代码', group: 'document' },
  { key: 'invoiceDate', label: '开票日期', group: 'document' },
];

export const COMMON_TRANSACTION_FORM_FIELDS: TransactionFormOptionalKey[] = [
  'payeeId', 'locationId', 'tagIds', 'note',
];

export function transactionFormFieldOptions(usesAccounts: boolean): TransactionFormFieldOption[] {
  return TRANSACTION_FORM_FIELDS.filter((field) => usesAccounts || !field.accountsOnly);
}

export function transactionFormFieldGroups(usesAccounts: boolean): { key: TransactionFormFieldGroupKey; label: string; fields: TransactionFormFieldOption[] }[] {
  const options = transactionFormFieldOptions(usesAccounts);
  return TRANSACTION_FORM_FIELD_GROUPS
    .map((group) => ({ ...group, fields: options.filter((field) => field.group === group.key) }))
    .filter((group) => group.fields.length > 0);
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
    .map((x) => x.trim() === 'merchant' ? 'payeeId' : x.trim() === 'locationName' ? 'locationId' : x.trim())
    .filter((key) => allowed.has(key as TransactionFormOptionalKey)))];
}
