/** Short-lived, memory-only handoff from the login form to the ledger unlock gate. */
const passwords = new Map<string, { value: string; expiresAt: number }>();

function key(serverId: string, accountId: string): string { return `${serverId}/${accountId}`; }

export function rememberLoginPassword(serverId: string, accountId: string, password: string): void {
  passwords.set(key(serverId, accountId), { value: password, expiresAt: Date.now() + 120_000 });
}

export function takeLoginPassword(serverId?: string, accountId?: string): string | undefined {
  if (!serverId || !accountId) return undefined;
  const id = key(serverId, accountId);
  const entry = passwords.get(id);
  passwords.delete(id);
  return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
}
