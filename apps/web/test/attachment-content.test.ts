import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlLedgerStore } from '@zichan/db';
import { attachmentPreviewKind, loadAttachmentContent } from '../src/attachment-content.js';
import { ensureAttachmentBlobAvailable } from '../src/attachment-sync.js';
import { readAttachmentBlob } from '../src/db/attachment-storage.js';

vi.mock('../src/attachment-sync.js', () => ({ ensureAttachmentBlobAvailable: vi.fn() }));
vi.mock('../src/db/attachment-storage.js', () => ({ readAttachmentBlob: vi.fn() }));

const store = {} as SqlLedgerStore;
const reference = { fileName: '凭证.pdf', mimeType: 'application/pdf', sha256: 'original', sizeBytes: 300, thumbnailSha256: 'thumbnail' };
beforeEach(() => vi.resetAllMocks());

describe('附件预览类型', () => {
  it('识别图片、PDF 和缺失 MIME 的旧附件，不把普通文件当图片', () => {
    expect(attachmentPreviewKind({ fileName: 'receipt', mimeType: 'image/jpeg' })).toBe('image');
    expect(attachmentPreviewKind({ fileName: 'receipt', mimeType: 'Application/PDF; version=1.7' })).toBe('pdf');
    expect(attachmentPreviewKind({ fileName: '发票.PDF', mimeType: 'application/octet-stream' })).toBe('pdf');
    expect(attachmentPreviewKind({ fileName: '照片.JPG' })).toBe('image');
    expect(attachmentPreviewKind({ fileName: 'notes.txt', mimeType: 'text/plain', thumbnailSha256: 'thumbnail' })).toBeUndefined();
    expect(attachmentPreviewKind({ fileName: 'misleading.pdf', mimeType: 'text/plain' })).toBeUndefined();
  });
});

describe('附件原文读取', () => {
  it('未保存附件直接使用原始 Blob，不使用缩略图', async () => {
    const original = new Blob(['original']);
    expect(await loadAttachmentContent(store, { ...reference, contentBlob: original, thumbnailBlob: new Blob(['small']) })).toBe(original);
    expect(ensureAttachmentBlobAvailable).not.toHaveBeenCalled();
  });

  it('按正文引用取回原图，缩略图引用不参与读取', async () => {
    const original = new Blob(['full resolution']);
    vi.mocked(readAttachmentBlob).mockResolvedValue(original);
    expect(await loadAttachmentContent(store, reference)).toBe(original);
    expect(ensureAttachmentBlobAvailable).toHaveBeenCalledWith(store, { sha256: 'original', sizeBytes: 300, mimeType: 'application/pdf' });
    expect(readAttachmentBlob).toHaveBeenCalledWith('original', 'application/pdf');
  });

  it('账号只读预览通过授权接口读取，不访问本机附件存储', async () => {
    const blob = new Blob(['server preview']);
    const download = vi.fn().mockResolvedValue({ blob });
    expect(await loadAttachmentContent(store, reference, download)).toBe(blob);
    expect(download).toHaveBeenCalledWith('original');
    expect(ensureAttachmentBlobAvailable).not.toHaveBeenCalled();
    expect(readAttachmentBlob).not.toHaveBeenCalled();
  });

  it('缺少正文或离线取回失败时报告错误，不用缩略图冒充原图', async () => {
    await expect(loadAttachmentContent(store, { fileName: 'receipt.png', thumbnailSha256: 'thumbnail' })).rejects.toThrow('缺少正文引用');
    await expect(loadAttachmentContent(store, { fileName: 'receipt.png', sha256: 'original' })).rejects.toThrow('缺少大小信息');
    vi.mocked(ensureAttachmentBlobAvailable).mockRejectedValue(new Error('离线且本机没有此附件'));
    await expect(loadAttachmentContent(store, reference)).rejects.toThrow('离线且本机没有此附件');
    expect(readAttachmentBlob).not.toHaveBeenCalled();
  });
});
