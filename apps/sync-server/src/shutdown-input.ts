import type { Readable } from 'node:stream';

export type ShutdownInputReason = 'stdin shutdown' | 'stdin EOF';

export function watchShutdownInput(
  input: Readable,
  requestShutdown: (reason: ShutdownInputReason) => void,
): () => void {
  let buffer = '';
  let requested = false;
  const requestOnce = (reason: ShutdownInputReason) => {
    if (requested) return;
    requested = true;
    requestShutdown(reason);
  };
  const onData = (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    if (lines.some((line) => line.trim().toLowerCase() === 'shutdown')) requestOnce('stdin shutdown');
    if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
  };
  const onEnd = () => requestOnce('stdin EOF');

  input.setEncoding('utf8');
  input.on('data', onData);
  input.once('end', onEnd);
  input.resume();
  return () => {
    input.off('data', onData);
    input.off('end', onEnd);
  };
}
