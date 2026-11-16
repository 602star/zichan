import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogRequestContext {
  requestId: string; ip: string; userAgent: string; method: string; instanceId: string;
  authMethod?: string; actorId?: string; role?: string;
}

export const logRequestContext = new AsyncLocalStorage<LogRequestContext>();

/** A log never carries request bodies, cookies, query strings or raw authorization. */
export function safeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[层级过深]';
  if (typeof value === 'string') return value.slice(0, 16000)
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [已脱敏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[已脱敏]')
    .replace(/((?:password|token|secret|device_key|api_key|authorization|cookie|invite_?code|reset_?code|recovery_?code)\s*[=:]\s*)[^\s&,;"']+/gi, '$1[已脱敏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[已脱敏]@');
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeLogValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 150).map(([key, item]) => [key,
    /password|passphrase|secret|token|authorization|cookie|credential|device.?key|private.?key|api.?key|invite.?code|reset.?code|recovery.?code|request.?body|sql.?params/i.test(key) ? '[已脱敏]' : safeLogValue(item, depth + 1)]));
  return value;
}

export function logComponent(action: string): string {
  if (/login|logout|mfa|session|device|auth/.test(action)) return 'auth';
  if (/job|backup|restore|cleanup|prune/.test(action)) return 'tasks';
  if (/blob|storage|quota/.test(action)) return 'storage';
  if (/sync|commit|replica|node/.test(action)) return 'sync';
  if (/alert|notify|metrics|sample/.test(action)) return 'observability';
  return 'server';
}
