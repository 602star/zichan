import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

const normalize = (ip: string) => ip.replace(/^::ffff:/i, '');
const loopback = (ip: string) => ip === '::1' || /^127\./.test(ip) && isIP(ip) === 4;

/** Compile deployment trust once, never accept a request header as a trust rule. */
export function createRequestOrigin(trustedProxies: string[], allowInsecureHttp = false) {
  const allowed = new BlockList();
  function add(rule: string) {
    const [rawAddress, prefix, extra] = rule.split('/');
    const address = normalize(rawAddress ?? '');
    const family = isIP(address);
    if (!family || extra !== undefined) throw new Error(`Invalid trusted proxy: ${rule}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) allowed.addAddress(address, type);
    else {
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
        throw new Error(`Invalid trusted proxy prefix: ${rule}`);
      }
      allowed.addSubnet(address, bits, type);
    }
  }
  for (const rule of trustedProxies) {
    if (rule === 'loopback' || rule === 'private') {
      add('127.0.0.0/8');
      add('::1');
    }
    if (rule === 'private') {
      // Docker images opt in by default; a deployment can replace this with
      // the actual proxy IP/CIDR when its network topology is known.
      for (const subnet of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10']) add(subnet);
    } else if (rule !== 'loopback') add(rule);
  }
  const trusted = (address: string) => {
    const family = isIP(address);
    return family !== 0 && allowed.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
  return {
    /** The direct socket peer alone decides whether deployment metadata is trusted. */
    trustedPeer(req: IncomingMessage): boolean {
      return trusted(normalize(req.socket.remoteAddress ?? 'unknown'));
    },
    browserOrigin(req: IncomingMessage): string | undefined {
      const remote = normalize(req.socket.remoteAddress ?? 'unknown');
      const host = req.headers.host;
      if (!host || /[\s/\\@?#]/.test(host)) return undefined;
      const trustedProxy = trusted(remote);
      // A browser supplies Origin itself. With explicitly enabled HTTP, a
      // container bridge may hide the host-network proxy's socket address.
      // Match Origin against the forwarded Host instead of trusting an
      // unverified X-Forwarded-Proto header for browser cookie requests.
      if (allowInsecureHttp && !trustedProxy && typeof req.headers.origin === 'string') {
        try {
          const browser = new URL(req.headers.origin);
          if ((browser.protocol === 'https:' || browser.protocol === 'http:')
            && browser.origin === req.headers.origin
            && browser.host === new URL(`${browser.protocol}//${host}`).host) return browser.origin;
        } catch { /* Invalid browser Origin or Host falls through to the direct-HTTP policy. */ }
      }
      // Docker's host-port mapping can make a direct LAN request appear to
      // come from a trusted bridge gateway. With HTTP explicitly enabled,
      // absence of proxy metadata still means a direct HTTP request.
      const protocol = trustedProxy
        ? (req.headers['x-forwarded-proto'] ?? (allowInsecureHttp ? 'http' : undefined))
        : 'http';
      if (protocol !== 'https' && protocol !== 'http') return undefined;
      try {
        const url = new URL(`${protocol}://${host}`);
        // Direct loopback HTTP always gets browser cookies. LAN/public HTTP only
        // qualifies when the deployment explicitly enabled insecure transport,
        // so a bare HOST=0.0.0.0 binding does not silently hand out sessions.
        if (protocol === 'http' && !allowInsecureHttp) {
          const hostname = url.hostname.replace(/^\[|\]$/g, '');
          if (!loopback(remote) || trustedProxy || !(hostname === 'localhost' || loopback(hostname))) return undefined;
        }
        return url.origin;
      } catch {
        return undefined;
      }
    },
    clientIp(req: IncomingMessage): string {
      const remote = normalize(req.socket.remoteAddress ?? 'unknown');
      const header = req.headers['x-forwarded-for'];
      if (!trusted(remote) || typeof header !== 'string') return remote;
      const hops = header.split(',').map((value) => normalize(value.trim()));
      if (hops.some((hop) => !isIP(hop))) return remote;
      let current = remote;
      for (let index = hops.length - 1; index >= 0 && trusted(current); index -= 1) current = hops[index]!;
      return current;
    },
    secureTransport(req: IncomingMessage, allowInsecureHttp: boolean): boolean {
      if (allowInsecureHttp) return true;
      const remote = normalize(req.socket.remoteAddress ?? 'unknown');
      // A loopback proxy is still forwarding a remote request. XFF must never
      // grant the direct-local HTTP exception. Require one overwritten proto.
      if (trusted(remote)) return req.headers['x-forwarded-proto'] === 'https';
      return loopback(remote);
    },
  };
}
