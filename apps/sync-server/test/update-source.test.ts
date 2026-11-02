import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listUpdateFeedVersions, readUpdateAsset } from '../src/update-source.js';

const saved = {
  UPDATE_FEED_DIR: process.env.UPDATE_FEED_DIR,
  UPDATE_FEED_URL: process.env.UPDATE_FEED_URL,
  UPDATE_GITHUB_REPO: process.env.UPDATE_GITHUB_REPO,
  UPDATE_GITHUB_TOKEN_FILE: process.env.UPDATE_GITHUB_TOKEN_FILE,
};
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

describe('update sources', () => {
  it('reads a local signed feed without exposing private paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zichan-update-source-'));
    try {
      delete process.env.UPDATE_FEED_URL;
      delete process.env.UPDATE_GITHUB_REPO;
      process.env.UPDATE_FEED_DIR = directory;
      await writeFile(join(directory, 'latest.json'), 'signed');
      await writeFile(join(directory, 'zichan-0.3.3.feed.json'), 'signed');
      expect((await readUpdateAsset('latest.json', 4096)).toString()).toBe('signed');
      expect(await listUpdateFeedVersions()).toEqual(['0.3.3']);
      await expect(readUpdateAsset('../secret', 4096)).rejects.toThrow('名称无效');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uses a read-only GitHub token only for API calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zichan-github-source-'));
    try {
      delete process.env.UPDATE_FEED_DIR;
      delete process.env.UPDATE_FEED_URL;
      process.env.UPDATE_GITHUB_REPO = 'example/private';
      process.env.UPDATE_GITHUB_TOKEN_FILE = join(directory, 'token');
      await writeFile(process.env.UPDATE_GITHUB_TOKEN_FILE, 'github_pat_' + 'A'.repeat(32));
      const calls: Array<{ url: string; authorization?: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ url: input, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
        if (input.endsWith('/releases?per_page=100')) return new Response(JSON.stringify([
          { tag_name: 'v0.3.3', draft: false, prerelease: false,
            assets: [{ id: 7, name: 'latest.json', size: 6 }] },
        ]));
        if (input.endsWith('/assets/7')) return new Response(null, {
          status: 302, headers: { location: 'https://release-assets.githubusercontent.com/signed' },
        });
        return new Response('signed');
      }));
      expect((await readUpdateAsset('latest.json', 4096)).toString()).toBe('signed');
      expect(await listUpdateFeedVersions()).toEqual(['0.3.3']);
      expect(calls.find((entry) => entry.url === 'https://release-assets.githubusercontent.com/signed')?.authorization).toBeUndefined();
      expect(calls[0]?.authorization).toMatch(/^Bearer github_pat_/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a GitHub asset redirect outside the release asset hosts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zichan-github-redirect-'));
    try {
      delete process.env.UPDATE_FEED_DIR;
      delete process.env.UPDATE_FEED_URL;
      process.env.UPDATE_GITHUB_REPO = 'example/private';
      process.env.UPDATE_GITHUB_TOKEN_FILE = join(directory, 'token');
      await writeFile(process.env.UPDATE_GITHUB_TOKEN_FILE, 'github_pat_' + 'A'.repeat(32));
      vi.stubGlobal('fetch', vi.fn(async (input: string) => input.endsWith('/releases?per_page=100')
        ? new Response(JSON.stringify([{ tag_name: 'v0.3.3', draft: false, prerelease: false,
          assets: [{ id: 7, name: 'latest.json', size: 6 }] }]))
        : new Response(null, { status: 302, headers: { location: 'https://example.invalid/collect' } })));
      await expect(readUpdateAsset('latest.json', 4096)).rejects.toThrow('重定向地址不可信');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not follow redirects from an ordinary HTTPS feed', async () => {
    delete process.env.UPDATE_FEED_DIR;
    delete process.env.UPDATE_GITHUB_REPO;
    process.env.UPDATE_FEED_URL = 'https://updates.example.test/latest.json';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'https://release-assets.githubusercontent.com/other' },
    })));
    await expect(readUpdateAsset('latest.json', 4096)).rejects.toThrow('不允许重定向');
  });
});
