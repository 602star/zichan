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
