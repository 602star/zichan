/**
 * Reviewed exceptions to the "no credentials over plaintext to a public host"
 * rule.
 *
 * Two independent layers enforce that rule and both have to be told about an
 * exception:
 *
 *  1. `assertSecureSyncUrl` (@zichan/db) - the application gate that runs before
 *     a request is built.
 *  2. The `connect-src` of the Content-Security-Policy that @zichan/sync-server
 *     attaches to the web app it hosts - the browser gate that runs after.
 *
 * They live in one list here because the failure mode of duplicating them is
 * silent: the app gate passes, the browser blocks the fetch, and the operator
 * sees a connection failure with no hint that a header is responsible. That is
 * exactly what happened with the first entry.
 *
 * This list is deliberately NOT part of `localNetworkHostname`. That function
 * answers "is this host on my private network?", and its answer decides whether
 * a server is stored as device-local or shared. Hosts here are public, so
 * letting them into the private-network predicate would file them under a single
 * device's scope and hide them from other devices.
 *
 * Every entry weakens the transport guarantee. On plain HTTP anyone on the path
 * reads the bearer token and - worse - can rewrite the application itself, which
 * defeats the ledger's end-to-end encryption because the key is unwrapped in the
 * page. Remove an entry as soon as its host terminates TLS.
 */
export const PLAIN_HTTP_HOST_ALLOWLIST: readonly string[] = ['test.ojco.de'];

/**
 * True when `hostname` is exactly a reviewed plain-HTTP host.
 *
 * Matching is case-insensitive and host-exact. No wildcard is accepted, so a
 * new entry is always an explicit decision, and subdomains that merely look
 * similar are not covered.
 */
export function isPlainHttpHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return PLAIN_HTTP_HOST_ALLOWLIST.includes(value);
}
