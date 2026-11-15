/** Each field remains in exactly one task group; values and validation stay with the original form. */
export function formTaskGroups<T extends { key: string }>(fields: T[], moneyFirst = false): { title: string; fields: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const field of fields) {
    const key = field.key;
    const title = /^(gameId|seasonId|gameAccountId|name|title|type|recordType|category|categoryId|description|brand|model|barcode|status)$/.test(key) ? '记录内容'
      : /amount|price|assetId|currency|accountId|cashflow|fee|quantity|unitCost/i.test(key) ? '金额与账户'
      : /date|time|month|interval|frequency|period/i.test(key) ? '日期与周期' : '其他信息';
    buckets.set(title, [...(buckets.get(title) ?? []), field]);
  }
  const order = moneyFirst ? ['金额与账户', '记录内容', '日期与周期', '其他信息'] : ['记录内容', '金额与账户', '日期与周期', '其他信息'];
  return order.filter((title) => buckets.has(title)).map((title) => ({ title, fields: buckets.get(title)! }));
}
