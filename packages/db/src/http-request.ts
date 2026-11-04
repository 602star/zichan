export interface HttpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface JsonRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'error';
  credentials?: 'same-origin' | 'omit';
  cache?: 'no-store';
  keepalive?: boolean;
}

export class HttpRequestError extends Error {
  constructor(readonly kind: 'network' | 'timeout' | 'http', message: string, readonly status = 0) { super(message); }
}

/** One attempt only. The deadline covers both headers and the entire JSON body. */
export async function requestJson(url: string, init: JsonRequestInit = {}, options: HttpRequestOptions = {}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new Error('请求已取消')); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) { cancel(); return; }
    timer = setTimeout(() => {
      controller.abort();
      reject(new HttpRequestError('timeout', init.method && init.method !== 'GET'
        ? '请求超时，服务器可能已完成操作。请先核实结果，未自动重复提交。'
        : '读取超时，请检查服务器连接后重试。'));
    }, options.timeoutMs ?? 15_000);
  });
  const work = async () => {
    if (controller.signal.aborted) throw new Error('请求已取消');
    let response: Response;
    try { response = await fetch(url, { ...init, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new HttpRequestError('network', '无法连接服务器，请检查网络或服务器状态。');
    }
    // Keep HTTP status even when a proxy serves HTML for an error response.
    let body: unknown;
    try { body = await response.json(); }
    catch (error) {
      if (response.ok) {
        if (controller.signal.aborted) throw error;
        if (error instanceof TypeError) throw new HttpRequestError('network', '读取服务器响应中断，请检查网络后重试。');
        throw new Error('服务器未返回有效 JSON，请检查 API 地址或反向代理配置。');
      }
    }
    return { ok: response.ok, status: response.status, json: async () => body };
  };
  try { return await Promise.race([work(), interrupted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
