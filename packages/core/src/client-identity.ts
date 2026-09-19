/**
 * Client identification for sync requests.
 *
 * The sync diagnostics page answers "why can't this device sync", and one of the
 * answers is "that device is running a build from before the current protocol".
 * That question cannot be answered from `deviceName`, which is a self-chosen label
 * (often just "Zichan · 当前设备") and says nothing about the build.
 *
 * So a client states what it is in a request header. Two properties matter:
 *
 *  - **It is self-reported, so it is evidence and not authority.** Nothing in the
 *    server branches on it: an old client that lies, or sends nothing at all, still
 *    syncs exactly as before. It exists so an operator can see it.
 *  - **Absent is not the same as old.** A client that never sends the header leaves
 *    the fields empty, and the console shows "未知" rather than inventing a version.
 *    That distinction matters because most historical events predate this header.
 *
 * The format is a small `key=value` list with a version tag so it can grow without
 * breaking readers: unknown keys are ignored, and a value that does not parse is
 * treated as no identification at all.
 */

/**
 * Sync protocol generation this build speaks. Bumped when the relay API changes in a
 * way an older client cannot follow, so diagnostics can name the mismatch directly.
 */
export const SYNC_PROTOCOL_VERSION = '3';

/** Request header carrying the client identity. */
export const CLIENT_IDENTITY_HEADER = 'X-Zichan-Client';

export interface ClientIdentity {
  /** Client family: `web`, `desktop`, `mobile`. */
  kind: string;
  /** Build version of the client application. */
  version: string;
  /** Sync protocol generation the client speaks. */
  protocol: string;
}

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,32}$/;
const PROTOCOL = /^[A-Za-z0-9._-]{1,16}$/;

/** Serializes to `zichan-client/1 kind=web version=0.1.0 protocol=3`. */
export function formatClientIdentity(identity: ClientIdentity): string {
  if (!KIND.test(identity.kind) || !VERSION.test(identity.version) || !PROTOCOL.test(identity.protocol)) {
    // Refusing here rather than sending a malformed value keeps a bad build from
    // writing nonsense into every diagnostic record it produces.
    throw new Error('客户端标识格式无效');
  }
  return `zichan-client/1 kind=${identity.kind} version=${identity.version} protocol=${identity.protocol}`;
}

/**
 * Parses a client identity header.
 *
 * Returns `undefined` for anything unusable — a missing header, an unknown format
 * tag, or a value whose parts do not match the expected shape. Partial data is
 * never returned: a half-parsed identity would show a version against the wrong
 * client kind.
 */
export function parseClientIdentity(value: string | undefined | null): ClientIdentity | undefined {
  if (!value || value.length > 200) return undefined;
  const parts = value.trim().split(/\s+/);
  if (parts[0] !== 'zichan-client/1') return undefined;
  const fields = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    fields.set(part.slice(0, at), part.slice(at + 1));
  }
  const kind = fields.get('kind') ?? '';
  const version = fields.get('version') ?? '';
  const protocol = fields.get('protocol') ?? '';
  if (!KIND.test(kind) || !VERSION.test(version) || !PROTOCOL.test(protocol)) return undefined;
  return { kind, version, protocol };
}
