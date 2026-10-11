import { createHash, createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROLES = ['public', 'home', 'office'];
const REQUIRED_CAPABILITIES = ['node-replication-v1', 'portable-blobs-v2', 'encrypted-commits-v3'];

function baseUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid node URL: ${input}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function nodeKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const der = Buffer.from(value, 'base64url');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519'
      || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== value) return undefined;
    return createHash('sha256').update(der).digest('hex');
  } catch { return undefined; }
}

async function getJson(fetcher, url) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Public, unauthenticated deployment preflight; no passwords or ledger data are read. */
export async function inspectThreeNodes(urls, options = {}) {
  if (!Array.isArray(urls) || urls.length !== 3) throw new Error('Provide public, home and office URLs in that order.');
  const fetcher = options.fetcher ?? fetch;
  const normalized = urls.map(baseUrl);
  const issues = [];
  const warnings = [];
  if (new Set(normalized).size !== 3) issues.push('Three distinct node URLs are required.');
  const nodes = await Promise.all(normalized.map(async (url, index) => {
    const role = ROLES[index];
    const row = { role, url };
    const parsedUrl = new URL(url);
    const loopback = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(parsedUrl.hostname);
    if (index === 0 && parsedUrl.protocol !== 'https:' && !(options.allowLocalHttp && loopback)) {
      issues.push('The public node must use HTTPS.');
    }
    try {
      const [health, ready] = await Promise.all([
        getJson(fetcher, `${url}/api/health`),
        getJson(fetcher, `${url}/api/ready`),
      ]);
      row.serverId = health.serverId;
      row.nodePublicKey = health.nodePublicKey;
      row.nodeKeySha256 = nodeKey(health.nodePublicKey);
      row.schemaVersion = ready.database?.schemaVersion;
      row.protocols = health.protocols;
      row.capabilities = health.capabilities;
      row.basePath = health.basePath;
      const path = new URL(url).pathname.replace(/\/+$/, '');
      if (health.ok !== true || ready.ok !== true || health.serverId !== ready.serverId) {
        issues.push(`${role}: health and readiness do not agree.`);
      }
      if (typeof row.serverId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(row.serverId)
        || !row.nodeKeySha256) issues.push(`${role}: node identity is missing or invalid.`);
      if (health.basePath !== path) issues.push(`${role}: configured URL path differs from server basePath.`);
      if (health.syncEnabled !== true || health.webEnabled !== true || health.claimed !== true) {
        issues.push(`${role}: sync, hosted web or node ownership is not ready.`);
      }
      if (!Array.isArray(health.protocols) || !health.protocols.includes(3)
        || !Array.isArray(health.capabilities)
        || REQUIRED_CAPABILITIES.some((capability) => !health.capabilities.includes(capability))) {
        issues.push(`${role}: required replica protocol capability is missing.`);
      }
      if (!Number.isSafeInteger(row.schemaVersion) || row.schemaVersion < 1) {
        issues.push(`${role}: database schema version is unavailable.`);
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      issues.push(`${role}: ${row.error}`);
    }
    return row;
  }));
  const ids = nodes.map((node) => node.serverId).filter(Boolean);
  const keys = nodes.map((node) => node.nodePublicKey).filter(Boolean);
  if (ids.length === 3 && new Set(ids).size !== 3) issues.push('Node IDs are not distinct.');
  if (keys.length === 3 && new Set(keys).size !== 3) issues.push('Node signing keys are not distinct.');
  const versions = nodes.map((node) => node.schemaVersion).filter((value) => Number.isSafeInteger(value));
  if (versions.length === 3 && new Set(versions).size !== 1) {
    warnings.push('Node database schema versions differ; an explicitly retired legacy shadow may use schema 25 while another node uses schema 24. Verify application versions separately.');
  }
  return { ok: issues.length === 0, nodes, issues, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const allowLocalHttp = args[0] === '--allow-local-http';
  const urls = allowLocalHttp ? args.slice(1) : args;
  try {
    const result = await inspectThreeNodes(urls, { allowLocalHttp });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
