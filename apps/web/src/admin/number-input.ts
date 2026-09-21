/** Quotas use GiB in the form and integer bytes on the wire. Never return null. */
export function quotaBytesFromGiB(raw: string): number {
  const value = raw.trim();
  if (!/^\d+(?:\.\d{1,30})?$/.test(value) || value.length > 40) throw new Error('请输入纯数字 GiB，最多 30 位小数，不支持单位或科学计数法。');
  const [whole, fraction = ''] = value.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`) * 1073741824n;
  if (numerator < 1048576n * scale || numerator > 1099511627776n * scale) throw new Error('配额范围为 1 MiB 至 1024 GiB（最小 0.0009765625 GiB）。');
  // Round to the nearest byte, without floating-point conversion of the draft.
  return Number((numerator + scale / 2n) / scale);
}

export function settingNumber(raw: string, minimum?: number, maximum?: number): number {
  const value = raw.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('请输入有效数字，不能为空或包含单位。');
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) throw new Error('数字超出安全精度范围。');
  if ((minimum !== undefined && number < minimum) || (maximum !== undefined && number > maximum)) throw new Error(`允许范围：${minimum ?? '不限'}–${maximum ?? '不限'}。`);
  return number;
}
