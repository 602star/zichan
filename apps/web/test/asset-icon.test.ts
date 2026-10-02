import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetIcon } from '../src/ui/AssetIcon.js';

describe('asset currency marks', () => {
  it('renders local marks for a fiat currency and a known cryptocurrency', () => {
    const fiat = renderToStaticMarkup(createElement(AssetIcon, { code: 'GBP' }));
    const crypto = renderToStaticMarkup(createElement(AssetIcon, { code: 'BTC' }));
    expect(fiat).toContain('£');
    expect(crypto).toContain('<svg');
    expect(fiat + crypto).not.toContain('http');
    expect(fiat).toContain('aria-hidden="true"');
  });

  it('uses a short fallback for user-defined assets', () => {
    expect(renderToStaticMarkup(createElement(AssetIcon, { code: 'CUSTOM' }))).toContain('CU');
    expect(renderToStaticMarkup(createElement(AssetIcon, { code: '' }))).toContain('¤');
  });
});
