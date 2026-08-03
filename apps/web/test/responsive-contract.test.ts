import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const transactions = readFileSync(new URL('../src/screens/Transactions.tsx', import.meta.url), 'utf8');
const reports = readFileSync(new URL('../src/screens/Reports.tsx', import.meta.url), 'utf8');
const serverAdmin = readFileSync(new URL('../src/screens/ServerAdmin.tsx', import.meta.url), 'utf8');

describe('responsive shell contract', () => {
  it('defines the agreed phone, tablet, and desktop breakpoints', () => {
    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('@media (min-width: 768px) and (max-width: 1199px)');
    expect(css).toContain('@media (min-width: 1200px)');
  });

  it('provides mobile navigation, safe areas, dynamic viewport height, and touch targets', () => {
    expect(app).toContain('zc-mobile-bottom-nav');
    expect(app).toContain('zc-mobile-drawer');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('100dvh');
    expect(css).toMatch(/button,[\s\S]*?min-height:\s*44px/);
    expect(css).toMatch(/button\s*\{[\s\S]*?min-width:\s*44px/);
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('interactive-widget=resizes-content');
  });

  it('makes phone forms keyboard-safe and keeps large category lists scrollable', () => {
    expect(css).toContain('.zc-entity-modal');
    expect(css).toContain('height: 100dvh');
    expect(css).toContain('.zc-modal-footer');
    expect(css).toContain('position: sticky');
    expect(css).toContain('.zc-category-picker-list');
    expect(css).toContain('-webkit-overflow-scrolling: touch');
  });

  it('reflows dense ledger and server controls while keeping charts scrollable', () => {
    expect(transactions).toContain('zc-account-filter-grid');
    expect(transactions).toContain('zc-transaction-timeline-entry');
    expect(transactions).toContain('zc-budget-grid');
    expect(serverAdmin).toContain('zc-server-admin-connection');
    expect(serverAdmin).toContain('zc-server-admin-kpi-grid');
    expect(reports).toContain('zc-report-chart-grid');
    expect(css).toContain('.zc-report-chart-grid');
    expect(css).toContain('overscroll-behavior-inline: contain');
  });
});
