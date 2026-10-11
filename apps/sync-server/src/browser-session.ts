import type { IncomingMessage, ServerResponse } from 'node:http';
import { ServerStoreError } from './store.js';

const COOKIE_NAME = 'zichan_session';
const cookieName = (req: IncomingMessage) => req.headers['x-zichan-session'] === 'admin-cookie' ? 'zichan_admin_session' : COOKIE_NAME;

/** Browser cookies and native JSON refresh tokens are deliberately separate transports. */
export function createBrowserSessionCookies(basePath: string, requestOrigin: (req: IncomingMessage) => string | undefined) {
  if (/[;\r\n?#]/.test(basePath)) throw new Error('Invalid browser session cookie path');
  const path = `${encodeURI(basePath)}/api/auth`;

  function requested(req: IncomingMessage): boolean {
    const transport = req.headers['x-zichan-session'];
    if (transport === undefined) return false;
    if (transport !== 'cookie' && transport !== 'admin-cookie') throw new ServerStoreError('INVALID_SESSION_TRANSPORT', 400, 'invalid session transport');
    const expected = requestOrigin(req);
    if (!expected || req.headers.origin !== expected) {
      throw new ServerStoreError('SESSION_ORIGIN_REJECTED', 403, 'browser sessions require a same-origin request');
    }
    // The custom header is also a CSRF barrier; it is not allowed by cross-origin CORS.
    return true;
  }

  function read(req: IncomingMessage): string | undefined {
    const name = cookieName(req);
    const values = (req.headers.cookie ?? '').split(';')
      .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
    if (values.length !== 1) return undefined;
    const value = values[0]!.slice(name.length + 1);
    return /^session-[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }

  function write(req: IncomingMessage, res: ServerResponse, token?: string): void {
    const secure = requestOrigin(req)?.startsWith('https://') ? '; Secure' : '';
    // Session-only until a separate, explicit trusted-device enrollment is implemented.
    // Ledger sessions allow a top-level redirect back from the trusted identity node.
    // Mutating cookie requests still require the same-origin custom header and Origin check.
    const sameSite = cookieName(req) === 'zichan_admin_session' ? 'Strict' : 'Lax';
    res.setHeader('Set-Cookie', `${cookieName(req)}=${token ?? ''}; Path=${path}; HttpOnly; SameSite=${sameSite}${secure}${token ? '' : '; Max-Age=0'}`);
  }

  return { requested, read, write };
}
