import { HttpRequestError } from '@zichan/db';

/** An authentication/identity/format failure is never a reason to bypass online validation. */
export function canOfferOfflineCache(error: unknown): boolean {
  return error instanceof HttpRequestError && (error.kind === 'network' || error.kind === 'timeout'
    || error.kind === 'http' && error.status >= 500 && error.status <= 599);
}
