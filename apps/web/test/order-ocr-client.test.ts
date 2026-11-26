import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalOcrSession } from '../src/order-capture/ocr-client.js';
import { prepareOcrResources, type PreparedOcrResources } from '../src/order-capture/resources.js';

vi.mock('../src/order-capture/resources.js', () => ({ ocrBaseUrl: () => new URL('https://local.example/ledger/'), prepareOcrResources: vi.fn() }));
vi.mock('../src/order-capture/image.js', () => ({ validateOrderImage: vi.fn(async () => ({ width: 100, height: 100 })) }));
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { super(); FakeWorker.instances.push(this); }
}
beforeEach(() => { vi.stubGlobal('Worker', FakeWorker); FakeWorker.instances = []; vi.mocked(prepareOcrResources).mockReset().mockResolvedValue({ storage: 'persistent', assets: [] }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('local OCR session lifecycle', () => {
  it('passes verified assets to a new worker and preserves session-mode progress when reusing it', async () => {
    const assets = [{ file: 'model.tar', blob: new Blob(['verified public model']) }];
    vi.mocked(prepareOcrResources).mockResolvedValue({ storage: 'session', assets });
    const session = new LocalOcrSession(), progress = vi.fn();
    const result = { initializationMs: 1, recognitionMs: 2, tileCount: 1, width: 100, height: 100, lines: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const promise = session.recognize(new Blob(['private image']), new AbortController().signal, progress);
      await vi.waitFor(() => expect(FakeWorker.instances[0]?.postMessage).toHaveBeenCalledTimes(attempt + 1));
      const worker = FakeWorker.instances[0]!, payload = worker.postMessage.mock.calls[attempt]![0];
      if (attempt === 0) expect(payload.assets).toEqual(assets);
      else expect(payload).not.toHaveProperty('assets');
      worker.dispatchEvent(new MessageEvent('message', { data: { id: payload.id, progress: { phase: 'initializing', current: 0, total: 1 } } }));
      expect(progress).toHaveBeenLastCalledWith({ phase: 'initializing', current: 0, total: 1, storage: 'session' });
      worker.dispatchEvent(new MessageEvent('message', { data: { id: payload.id, result } }));
      await promise;
    }
    expect(FakeWorker.instances).toHaveLength(1); session.dispose();
  });
  it('terminates a running worker on cancellation and rejects stale results', async () => {
    const session = new LocalOcrSession(), controller = new AbortController();
    const promise = session.recognize(new Blob(['private image']), controller.signal, () => undefined);
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.postMessage).toHaveBeenCalled());
    controller.abort(); await rejected;
    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
  it('disposal during resource preparation does not create a worker afterwards', async () => {
    let finish!: (prepared: PreparedOcrResources) => void;
    vi.mocked(prepareOcrResources).mockImplementationOnce(() => new Promise<PreparedOcrResources>((resolve) => { finish = resolve; }));
    const session = new LocalOcrSession();
    const promise = session.recognize(new Blob(), new AbortController().signal, () => undefined);
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(prepareOcrResources).toHaveBeenCalled());
    session.dispose(); finish({ storage: 'persistent', assets: [] }); await rejected;
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('does not forward raw SDK errors into the UI', async () => {
    const session = new LocalOcrSession();
    const promise = session.recognize(new Blob(), new AbortController().signal, () => undefined);
    const rejected = expect(promise).rejects.toThrow('本机识别失败');
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.postMessage).toHaveBeenCalled());
    const worker = FakeWorker.instances[0]!, id = worker.postMessage.mock.calls[0]![0].id;
    worker.dispatchEvent(new MessageEvent('message', { data: { id, error: 'private image and phone 13800138000' } }));
    await rejected; expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('records only bounded timing and shape metadata, then releases an idle worker', async () => {
    vi.useFakeTimers();
    const measure = vi.spyOn(performance, 'measure');
    const session = new LocalOcrSession();
    const promise = session.recognize(new Blob(), new AbortController().signal, () => undefined);
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.postMessage).toHaveBeenCalled());
    const worker = FakeWorker.instances[0]!, id = worker.postMessage.mock.calls[0]![0].id;
    worker.dispatchEvent(new MessageEvent('message', { data: { id, result: { initializationMs: 1, recognitionMs: 2, tileCount: 1, width: 100, height: 100, lines: [{ text: '13800138000' }] } } }));
    await promise;
    expect(measure).toHaveBeenCalledWith('zichan:local-ocr', { start: expect.any(Number), detail: {
      initializationMs: 1, recognitionMs: 2, tileCount: 1, width: 100, height: 100, lineCount: 1,
    } });
    expect(JSON.stringify(measure.mock.calls)).not.toContain('13800138000');
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
