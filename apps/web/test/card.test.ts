import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Card, CardAlert, CardHead } from '../src/ui/Card.js';
import { CardHeader } from '../src/ui/CardHeader.js';

describe('card semantics', () => {
  it('associates each sheet with its own heading and preserves explicit labels', () => {
    const markup = renderToStaticMarkup(createElement('main', null,
      createElement(Card, { title: '资产配置' }),
      createElement(Card, { title: '期间动态' }),
      createElement(Card, { 'aria-labelledby': 'outside-title' }),
    ));
    const references = [...markup.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(references).size).toBe(3);
    for (const id of references.slice(0, 2)) expect(markup).toContain(`id="${id}"`);
    expect(references[2]).toBe('outside-title');
  });

  it('preserves native disclosure and article structure', () => {
    const disclosure = renderToStaticMarkup(createElement(Card, { as: 'details', variant: 'flush', open: true },
      createElement('summary', null, '分析明细'), createElement('p', null, '预算偏差'),
    ));
    expect(disclosure).toMatch(/^<details[^>]*open=""[^>]*><summary>/);
    expect(renderToStaticMarkup(createElement(Card, { as: 'article', title: '相机' }))).toMatch(/^<article\b/);
    expect(CardHeader).toBe(CardHead);
  });

  it('reserves assertive announcements for explicitly urgent errors', () => {
    expect(renderToStaticMarkup(createElement(CardAlert, null, '缺少价格，请补录。'))).toContain('role="status"');
    expect(renderToStaticMarkup(createElement(CardAlert, { tone: 'danger', role: 'alert' }, '读取失败，请重试。'))).toContain('role="alert"');
  });
});
