export interface AccountScope {
  readonly origin: string;
  readonly serverId: string;
  readonly accountId: string;
  readonly ledgerId: string;
}

/** Stable IDs only: display usernames, aliases and editable profile IDs are not cache identities. */
export function createAccountScope(input: AccountScope): AccountScope {
  const url = new URL(input.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('账号缓存必须绑定网站来源，不接受路径或凭据');
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(input.serverId)
    || !/^account-[a-f0-9]{32}$/.test(input.accountId)
    || !/^[A-Za-z0-9_-]{16,128}$/.test(input.ledgerId)) throw new Error('账号缓存身份不完整，不能退回公共缓存');
  return Object.freeze({ origin: url.origin, serverId: input.serverId, accountId: input.accountId, ledgerId: input.ledgerId });
}

export function accountScopeKey(input: AccountScope): string {
  const scope = createAccountScope(input);
  return JSON.stringify([1, scope.origin, scope.serverId, scope.accountId, scope.ledgerId]);
}
