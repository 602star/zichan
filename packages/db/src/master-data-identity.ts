import type { BaseEntity } from '@zichan/core';

export const normalizeIdentity = (value: unknown): string => String(value ?? '').trim().toLowerCase();
type Named = BaseEntity & Record<string, unknown>;
export function masterIdentity(kind: string, row: Named): string | undefined {
  if (kind === 'game_account') return JSON.stringify([row.gameId, normalizeIdentity(row.serverName), normalizeIdentity(row.accountName)]);
  if (kind === 'game_season') return JSON.stringify([row.gameId, normalizeIdentity(row.name)]);
  if (kind === 'transaction_tag') return JSON.stringify([normalizeIdentity(row.groupName), normalizeIdentity(row.name)]);
  if (kind === 'payee') return normalizeIdentity(row.name);
  return undefined;
}
export function duplicateMasterData(kind: string, candidate: Named, rows: Named[], current?: Named): Named[] {
  const key = masterIdentity(kind, candidate);
  if (key === undefined || (current && !current.isDeleted && masterIdentity(kind, current) === key)) return [];
  return rows.filter((row) => !row.isDeleted && row.id !== candidate.id && (
    masterIdentity(kind, row) === key || (kind === 'payee' && Array.isArray(row.aliases) && row.aliases.some((alias) => normalizeIdentity(alias) === key))
  ));
}
export class DuplicateMasterDataError extends Error {
  constructor(public readonly kind: string, public readonly matches: Named[]) {
    super('已存在匹配的资料，请选择已有资料，或修改名称及所属范围。');
    this.name = 'DuplicateMasterDataError';
  }
}
