/**
 * Gentle numeric normalization for pasted financial amounts and quantities.
 *
 * Converts full-width digits/signs/dots, strips surrounding spaces, leading
 * currency symbols, and grouping commas so pasted values like `¥1,234.50` or
 * `１２０．５` parse cleanly with Decimal.js. Non-numeric input is returned
 * trimmed so downstream validation still rejects it with a clear message.
 */
const FULLWIDTH_DIGITS = /[０-９]/g;
const LEADING_CURRENCY = /^(?:US\$|HK\$|NT\$|CA\$|AU\$|S\$|RMB|CNY|USD|EUR|GBP|JPY|HKD|TWD|[¥￥$€£₩])\s*/i;
const TRAILING_CURRENCY = /\s*(?:RMB|CNY|USD|EUR|GBP|JPY|HKD|TWD|[¥￥$€£₩元])$/i;
const GROUPED_DECIMAL = /^[+-]?(?:\d{1,3}(?:[,，_ ]\d{3})+|\d+)(?:\.\d*)?$/;

export function sanitizeNumericInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let normalized = trimmed
    .replace(FULLWIDTH_DIGITS, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[－−—]/g, '-')
    .replace(/＋/g, '+');
  // Preserve leading sign if it precedes the currency symbol (e.g. -¥1,200).
  const signMatch = normalized.match(/^([+-])\s*/);
  const leadingSign = signMatch ? signMatch[1]! : '';
  const unsigned = signMatch ? normalized.slice(signMatch[0].length) : normalized;
  const withoutCurrency = unsigned
    .replace(LEADING_CURRENCY, '')
    .replace(TRAILING_CURRENCY, '')
    .trim();
  const candidate = `${leadingSign}${withoutCurrency}`;
  if (GROUPED_DECIMAL.test(candidate)) {
    return candidate.replace(/[,，_ ]/g, '');
  }
  return candidate;
}
