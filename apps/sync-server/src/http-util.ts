/** Shared HTTP plumbing for the sync/management surface. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { MAX_ENCRYPTED_CHUNK_BYTES } from './blob-store.js';
import { CLIENT_IDENTITY_HEADER, parseClientIdentity, type ClientIdentity } from '@zichan/core';
import { ServerStoreError, type JsonRecord, type SyncEventCategory } from './store.js';

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const AUTH_BODY_BYTES = 64 * 1024;
export const ADMIN_BODY_BYTES = 256 * 1024;

export class RequestBodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export function bearerToken(req: IncomingMessage): string {
  return headerValue(req, 'authorization').replace(/^Bearer\s+/i, '');
}

/**
 * Client identification for a sync request, or `undefined` when the client did not say.
 *
 * Read once per request and threaded into the diagnostic event. It is deliberately not
 * validated against anything: an unrecognised value means "unknown client", and the
 * request proceeds exactly as it would without the header.
 */
export function clientIdentity(req: IncomingMessage): ClientIdentity | undefined {
  return parseClientIdentity(headerValue(req, CLIENT_IDENTITY_HEADER));
}

export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<JsonRecord> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    const declared = Number(headerValue(req, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) tooLarge = true;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) tooLarge = true;
      else if (!tooLarge) body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new RequestBodyError(413, 'request body too large'));
      try {
        const parsed = body ? JSON.parse(body) as unknown : {};
        if (!isRecord(parsed)) throw new Error('body must be an object');
        resolveBody(parsed);
      } catch {
        reject(new RequestBodyError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function readBinaryBody(req: IncomingMessage, maxBytes = MAX_ENCRYPTED_CHUNK_BYTES): Promise<Uint8Array> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const declared = Number(headerValue(req, 'content-length'));
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) {
      reject(new RequestBodyError(declared > maxBytes ? 413 : 400, 'invalid binary content length'));
      req.resume();
      return;
    }
    req.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= maxBytes) chunks.push(chunk); });
    req.on('end', () => {
      if (bytes > maxBytes) reject(new RequestBodyError(413, 'request body too large'));
      else if (bytes !== declared) reject(new RequestBodyError(400, 'binary content length mismatch'));
      else resolveBody(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, contentType: string, body: string, filename?: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
  });
  res.end(body);
}

export function sendBinary(res: ServerResponse, status: number, body: Uint8Array): void {
  res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength), 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(body);
}

/**
 * Send bytes as a download the browser saves rather than renders.
 *
 * `Content-Disposition: attachment` is the point: the console is handing over a user's file, and
 * a file rendered in the admin page would run with the console's origin. The filename is stripped
 * of anything that could break out of the quoted parameter — a name with a quote or a newline in
 * it would otherwise let the ledger choose the response's header text.
 */
export function sendDownload(
  res: ServerResponse,
  status: number,
  body: Uint8Array,
  contentType: string,
  filename: string,
): void {
  const safeName = filename.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 120) || 'attachment';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  res.writeHead(status, {
    'Content-Type': /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : 'application/octet-stream',
    'Content-Length': String(body.byteLength),
    'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`,
    // Decrypted user content must never sit in a shared or browser cache.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function errorStatus(error: unknown, blob = false): number {
  if (error instanceof RequestBodyError || error instanceof ServerStoreError) return error.status;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'QUOTA_EXCEEDED') return 507;
  if (code === 'UPLOAD_NOT_FOUND') return 404;
  if (code === 'CHUNK_CHECKSUM_MISMATCH') return 422;
  if (['UPLOAD_INCOMPLETE', 'BLOB_ID_COLLISION', 'UPLOAD_MANIFEST_MISMATCH',
    'BLOB_MIGRATION_UNAVAILABLE'].includes(code)) return 409;
  return blob ? 400 : 500;
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof ServerStoreError) return error.code;
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

/**
 * Maps a server-visible failure to the diagnostic category shown to operators.
 * Client-side offline failures never reach this function, by design.
 */
export function syncEventCategory(code: string | undefined, status: number): SyncEventCategory {
  switch (code) {
    case 'SESSION_REVOKED':
    case 'UNAUTHORIZED':
    case 'CREDENTIALS_CHANGED':
    case 'INVALID_REFRESH':
      return 'session-invalid';
    case 'COMMIT_QUOTA_EXCEEDED':
    case 'QUOTA_EXCEEDED':
      return 'quota-exceeded';
    case 'INVALID_COMMIT':
    case 'INVALID_KEY_ENVELOPE':
    case 'INVALID_LEDGER_REPLACEMENT':
    case 'INVALID_LEDGER_ID':
      return 'protocol-incompatible';
    case 'REPLICA_UNBOUND':
    case 'LEDGER_MISMATCH':
    case 'KEYRING_MISMATCH':
    case 'BLOB_ID_COLLISION':
      return 'ledger-mismatch';
    default:
      return status >= 500 ? 'server-storage-error' : 'other';
  }
}

export function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
}
