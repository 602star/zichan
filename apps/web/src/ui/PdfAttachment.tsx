import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';

GlobalWorkerOptions.workerSrc = workerUrl;

// Vite emits these alongside the offline shell. PDF content never goes to a third-party viewer.
const assets = import.meta.glob('../../../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*.{bcmap,pfb,ttf,wasm}', { eager: true, query: '?url&no-inline', import: 'default' });
class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const directory = ({ cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as Record<string, string>)[kind];
    const url = assets[`../../../../node_modules/pdfjs-dist/${directory}/${filename}`];
    if (typeof url !== 'string') throw new Error(`PDF 资源不可用：${filename}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PDF 资源读取失败：${filename}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Flatten every page before masking. Never silently retain only the first page. */
export async function rasterizePdfForCapture(blob: Blob, signal: AbortSignal): Promise<{ blob: Blob; pages: number }> {
  signal.throwIfAborted();
  if (blob.size > 20 * 1024 ** 2) throw new Error('PDF 超过 20 MiB，请拆分后提取。');
  const data = await blob.arrayBuffer(); signal.throwIfAborted();
  const task = getDocument({ data, useWorkerFetch: false, BinaryDataFactory: PdfBinaryDataFactory, disableWorkerRendering: true, isOffscreenCanvasSupported: false });
  const abort = () => { void task.destroy().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const output = document.createElement('canvas');
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 6) throw new Error('当前最多提取 6 页 PDF，请拆分后处理；原附件未改变。');
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(index), base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / base.width) });
      pages.push({ page, viewport, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    }
    const width = Math.max(...pages.map((row) => row.width)), height = pages.reduce((sum, row) => sum + row.height, 0);
    if (!Number.isFinite(width * height) || width < 1 || height < 1 || height > 16000 || width * height > 24_000_000) throw new Error('PDF 页面像素过大，请拆分后提取。');
    output.width = width; output.height = height;
    const context = output.getContext('2d'); if (!context) throw new Error('无法生成 PDF 本机预览。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    let offset = 0;
    for (const row of pages) {
      signal.throwIfAborted();
      const canvas = document.createElement('canvas'); canvas.width = row.width; canvas.height = row.height;
      try {
        const canvasContext = canvas.getContext('2d'); if (!canvasContext) throw new Error('无法生成 PDF 页面。');
        await row.page.render({ canvas, canvasContext, viewport: row.viewport, background: '#fff' }).promise;
        signal.throwIfAborted(); context.drawImage(canvas, 0, offset); offset += row.height;
      } finally { canvas.width = 1; canvas.height = 1; row.page.cleanup(); }
    }
    const image = await new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error('PDF 本机预览生成失败。')), 'image/png'));
    signal.throwIfAborted();
    if (image.size > 20 * 1024 ** 2) throw new Error('PDF 转换图片超过 20 MiB，请拆分后处理。');
    return { blob: image, pages: pdf.numPages };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('此 PDF 需要密码，请先在本机阅读器解锁后再提取。');
    throw error;
  } finally { signal.removeEventListener('abort', abort); output.width = 1; output.height = 1; await task.destroy().catch(() => undefined); }
}

export default function PdfAttachment({ blob, zoom }: { blob: Blob; zoom: number }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [rendered, setRendered] = useState<{ pdf: PDFDocumentProxy; page: number; width: number; height: number; zoom: number }>();
  const [attempt, setAttempt] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    setPdf(undefined); setPage(1); setError(''); setBusy(true);
    void blob.arrayBuffer().then(async (data) => {
      if (!active) return;
      task = getDocument({ data, useWorkerFetch: false, BinaryDataFactory: PdfBinaryDataFactory, disableWorkerRendering: true, isOffscreenCanvasSupported: false });
      const document = await task.promise;
      if (active) setPdf(document);
    }).catch((reason) => {
      if (active) { setError(reason?.name === 'PasswordException' ? '此 PDF 需要密码，请保存后使用 PDF 阅读器打开。' : 'PDF 无法读取，请重试或保存原文件后查看。'); setBusy(false); }
    });
    return () => { active = false; void task?.destroy().catch(() => undefined); };
  }, [blob, attempt]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { setWidth(element.clientWidth); setHeight(element.clientHeight); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !width || !height) return;
    let active = true;
    let render: RenderTask | undefined;
    setBusy(true); setError('');
    // Each render owns its canvas. Rapid zoom/page changes cannot reuse a still-rendering canvas.
    const target = document.createElement('canvas');
    void pdf.getPage(page).then(async (pdfPage) => {
      if (!active) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(1.5, Math.max(1, width - 24) / base.width, Math.max(1, height - 24) / base.height) * zoom;
      const viewport = pdfPage.getViewport({ scale });
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      target.width = Math.max(1, Math.floor(viewport.width * density));
      target.height = Math.max(1, Math.floor(viewport.height * density));
      const context = target.getContext('2d');
      if (!context) throw new Error('Canvas 不可用');
      render = pdfPage.render({ canvas: target, canvasContext: context, viewport, transform: [density, 0, 0, density, 0, 0] });
      await render.promise;
      const visible = canvas.current;
      if (!active || !visible) return;
      visible.width = target.width; visible.height = target.height;
      visible.style.width = `${viewport.width}px`; visible.style.height = `${viewport.height}px`;
      visible.getContext('2d')?.drawImage(target, 0, 0);
      setRendered({ pdf, page, width, height, zoom });
      setBusy(false);
    }).catch(() => { if (active) { setError('此页无法显示，请重试或保存原文件后查看。'); setBusy(false); } });
    return () => { active = false; render?.cancel(); };
  }, [pdf, page, width, height, zoom]);

  const ready = rendered?.pdf === pdf && rendered?.page === page && rendered?.width === width && rendered?.height === height && rendered?.zoom === zoom;
  return <div className="zc-attachment-pdf">
    <div className="zc-attachment-toolbar" role="group" aria-label="PDF 翻页">
      <button type="button" className="zc-btn" aria-label="上一页" disabled={!pdf || page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} aria-hidden="true" /></button>
      <output aria-live="polite">第 {page} / {pdf?.numPages ?? '…'} 页</output>
      <button type="button" className="zc-btn" aria-label="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} aria-hidden="true" /></button>
    </div>
    <div ref={stage} className="zc-attachment-stage" tabIndex={0} aria-label="PDF 页面，可滚动查看" aria-busy={!error && (busy || !ready)}>
      {!error && (busy || !ready) && <div className="zc-attachment-status" role="status">正在读取 PDF 页面…</div>}
      {error && <div className="zc-attachment-status" role="alert"><p>{error}</p><button type="button" className="zc-btn" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>}
      <div className="zc-attachment-media" hidden={!ready || !!error}><canvas ref={canvas} role="img" aria-label={`PDF 第 ${page} 页`} /></div>
    </div>
  </div>;
}
