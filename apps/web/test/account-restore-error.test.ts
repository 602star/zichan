import { describe, expect, it } from 'vitest';
import { HttpRequestError } from '@zichan/db';
import { canOfferOfflineCache } from '../src/account-restore-error.js';

describe('offline cache availability after account restore failure', () => {
  it('allows transient failures regardless of navigator.onLine', () => {
    for (const error of [new HttpRequestError('network', ''), new HttpRequestError('timeout', ''), new HttpRequestError('http', '', 503)]) {
      expect(canOfferOfflineCache(error)).toBe(true);
    }
  });
  it('never treats denied authentication, changed identities or invalid JSON as offline', () => {
    for (const error of [new HttpRequestError('http', '', 401), new HttpRequestError('http', '', 403), new Error('服务器身份已变化'), new SyntaxError('HTML')]) {
      expect(canOfferOfflineCache(error)).toBe(false);
    }
  });
});
