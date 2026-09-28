import { describe, expect, it } from 'vitest';
import { fileNameFromDisposition } from '../src/admin/client.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The download name comes from the server's `Content-Disposition`, because the ledger's filename
 * is the only name that means anything to the person receiving the file. The console must not
 * invent one, and must not be fooled by a header it cannot parse.
 *
 * Both encodings are checked: a ledger's files routinely have non-ASCII names (发票.pdf), and the
 * plain `filename` parameter cannot carry them, which is why the server also sends `filename*`.
 */
describe('attachment download filename', () => {
  it('prefers the UTF-8 form, which is the only one that can carry a Chinese name', () => {
    const header = `attachment; filename="_.pdf"; filename*=UTF-8''${encodeURIComponent('发票.pdf')}`;
    expect(fileNameFromDisposition(header)).toBe('发票.pdf');
  });

  it('falls back to the plain form when there is no extended one', () => {
    expect(fileNameFromDisposition('attachment; filename="invoice.pdf"')).toBe('invoice.pdf');
  });

  it('returns empty for a missing or unparseable header so the caller can substitute its own', () => {
    expect(fileNameFromDisposition(null)).toBe('');
    expect(fileNameFromDisposition('attachment')).toBe('');
    // A malformed percent-escape must not throw inside a download; the plain form still answers.
    expect(fileNameFromDisposition('attachment; filename="ok.pdf"; filename*=UTF-8\'\'%E4%BD%')).toBe('ok.pdf');
  });
});

/**
 * "Exit preview" must actually close the session.
 *
 * This is a regression test for a bug the end-to-end preview test caught: the button called
 * `client.request(path, undefined)`, and that helper chooses GET when no body is passed, so the
 * DELETE never reached the server. Nothing failed — the page navigated away while the server kept
 * the decrypted ledger in memory until its TTL, which is precisely the state closing is supposed
 * to end.
 *
 * Asserted against the source rather than a rendered page because the mistake is in which method
 * is sent, and a DOM test with a stubbed client would happily accept either.
 */
describe('preview teardown', () => {
  it('sends DELETE, not the GET that `request` would choose for a bodyless call', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/admin/PreviewPage.tsx', import.meta.url)), 'utf8');
    const close = source.slice(source.indexOf('const closePreview'), source.indexOf('const loadBackup'));
    expect(close).toContain("client.send('DELETE'");
    // `request` cannot express DELETE at all, so its presence here means the bug is back.
    expect(close).not.toMatch(/client\.request\(/);
  });
});
