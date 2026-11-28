import type { ParsedOrder } from './types.js';

export const captureFields = [
  ['amount', 'amount', '实付金额'], ['paymentDate', 'date', '交易日期'], ['paymentTime', 'time', '交易时间'],
  ['merchant', 'merchant', '交易对象 / 商家'], ['product', 'description', '描述'], ['currency', 'assetId', '币种'],
  ['orderNumber', 'orderNumber', '订单号'], ['trackingNumber', 'trackingNumber', '物流单号'],
  ['invoiceNumber', 'invoiceNumber', '发票号码'], ['invoiceCode', 'invoiceCode', '发票代码'], ['invoiceDate', 'invoiceDate', '开票日期'],
] as const;

export function suggestedCaptureFields(order: ParsedOrder, values: Record<string, string>, manual: ReadonlySet<string>, currencyId?: string): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [source, target] of captureFields) {
    const field = order.fields[source];
    const value = source === 'currency' ? currencyId : field.value;
    if (field.state === 'suggested' && value && !manual.has(target) && (values[target] ?? '') !== value) selected[target] = value;
  }
  if (manual.has('date') || manual.has('time') || !selected.date) delete selected.time;
  return selected;
}

export function changedCaptureFields(baseline: Record<string, string>, current: Record<string, string>, selected: Record<string, string>, previousVersions: Record<string, number> = {}, versions: Record<string, number> = {}): string[] {
  return Object.keys(selected).filter((key) => (baseline[key] ?? '') !== (current[key] ?? '') || (previousVersions[key] ?? 0) !== (versions[key] ?? 0));
}

export function partitionCaptureFields(
  order: ParsedOrder | undefined,
  values: Record<string, string>,
  selected: Record<string, string>,
  edits: Record<string, string>,
  recognizedCurrencyId?: string,
) {
  const recognizedValue = (source: (typeof captureFields)[number][0]) => (
    source === 'currency'
      ? recognizedCurrencyId
      : order?.fields[source].value ?? order?.fields[source].candidates[0]?.value
  );
  const isRecognized = ([source, target]: (typeof captureFields)[number]) => {
    if (Object.hasOwn(edits, target) || Object.hasOwn(selected, target)) return true;
    const rec = recognizedValue(source);
    if (!rec) return false;
    if (target === 'assetId' && rec === values.assetId) return false;
    return true;
  };
  return {
    recognized: captureFields.filter(isRecognized),
    unrecognized: captureFields.filter((row) => !isRecognized(row)),
    recognizedValue,
  };
}
