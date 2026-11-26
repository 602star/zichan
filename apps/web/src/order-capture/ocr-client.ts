import { ocrBaseUrl, prepareOcrResources, type OcrProgress, type PreparedOcrResources } from './resources.js';
import { validateOrderImage } from './image.js';
import type { OcrResult } from './types.js';

export class LocalOcrSession {
  private worker?: Worker;
  private generation = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private preparation?: AbortController;
  private active?: { reject: (error: Error) => void };
  async recognize(file: Blob, signal: AbortSignal, progress: (value: OcrProgress) => void): Promise<OcrResult> {
    if (this.active || this.preparation) throw new Error('请等待当前识别完成。');
    clearTimeout(this.idleTimer);
    const started = performance.now();
    const id = ++this.generation;
    const preparation = new AbortController(); this.preparation = preparation;
    const abortPreparation = () => preparation.abort();
    let prepared: PreparedOcrResources;
    signal.addEventListener('abort', abortPreparation, { once: true });
    try {
      signal.throwIfAborted(); await validateOrderImage(file);
      preparation.signal.throwIfAborted(); prepared = await prepareOcrResources(preparation.signal, progress);
    } catch (cause) {
      if (id === this.generation) this.dispose();
      throw cause;
    } finally {
      signal.removeEventListener('abort', abortPreparation);
      if (this.preparation === preparation) this.preparation = undefined;
    }
    signal.throwIfAborted();
    if (id !== this.generation) throw new DOMException('识别已取消', 'AbortError');
    const initialize = !this.worker;
    this.worker ??= new Worker(new URL('./ocr-worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    return new Promise<OcrResult>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', cancel); worker.removeEventListener('message', message); worker.removeEventListener('error', failure); this.active = undefined; };
      const failure = () => { finish(); this.dispose(); reject(new Error('本机识别失败，可换图重试或继续手工记账。')); };
      const message = (event: MessageEvent<{ id: number; progress?: OcrProgress; error?: string; result?: OcrResult }>) => {
        if (event.data.id !== id) return;
        if (event.data.progress) progress({ ...event.data.progress, storage: prepared.storage });
        else if (event.data.error) failure();
        else if (event.data.result) {
          const data = event.data.result;
          performance.measure('zichan:local-ocr', { start: started, detail: { initializationMs: data.initializationMs, recognitionMs: data.recognitionMs,
            tileCount: data.tileCount, width: data.width, height: data.height, lineCount: data.lines.length } });
          finish(); this.idleTimer = setTimeout(() => this.dispose(), 30_000); resolve(data);
        }
      };
      const cancel = () => { finish(); this.dispose(); reject(new DOMException('识别已取消', 'AbortError')); };
      this.active = { reject: (error) => { finish(); reject(error); } };
      signal.addEventListener('abort', cancel, { once: true });
      worker.addEventListener('message', message); worker.addEventListener('error', failure);
      worker.postMessage({ id, file, baseUrl: new URL('ocr/', ocrBaseUrl()).href, ...(initialize ? { assets: prepared.assets } : {}) });
    });
  }
  dispose(): void {
    clearTimeout(this.idleTimer);
    this.preparation?.abort(); this.preparation = undefined;
    this.generation++; this.worker?.terminate(); this.worker = undefined;
    this.active?.reject(new DOMException('识别已取消', 'AbortError')); this.active = undefined;
  }
}
