import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const transactions = readFileSync(new URL('../src/screens/Transactions.tsx', import.meta.url), 'utf8');
const reports = readFileSync(new URL('../src/screens/Reports.tsx', import.meta.url), 'utf8');
const reportInsights = readFileSync(new URL('../src/ui/TransactionReportInsights.tsx', import.meta.url), 'utf8');
const serverAdmin = readFileSync(new URL('../src/screens/ServerAdmin.tsx', import.meta.url), 'utf8');
const dialogShell = readFileSync(new URL('../src/ui/DialogShell.tsx', import.meta.url), 'utf8');
const errorBoundary = readFileSync(new URL('../src/ui/AppErrorBoundary.tsx', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

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

  it('releases the mobile drawer lock when leaving the phone breakpoint', () => {
    expect(app).toContain("window.matchMedia('(max-width: 767px)')");
    expect(app).toContain("mobileViewport.addEventListener('change', closeOnDesktop)");
    expect(app).toContain('props.onMoreOpen(false); props.onImport();');
  });

  it('uses one accessible portal dialog foundation and a root recovery boundary', () => {
    expect(dialogShell).toContain('createPortal');
    expect(dialogShell).toContain('aria-modal="true"');
    expect(dialogShell).toContain('aria-labelledby={labelledBy}');
    expect(dialogShell).toContain("event.key !== 'Tab'");
    expect(dialogShell).toContain('restoreFocus.focus');
    expect(errorBoundary).toContain('重试当前页面');
    expect(errorBoundary).toContain('返回总览');
    expect(errorBoundary).toContain('复制诊断信息');
    expect(main.indexOf('<AppErrorBoundary>')).toBeLessThan(main.indexOf('<StoreProvider>'));
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
    expect(reportInsights).toContain('zc-report-insight-grid');
    expect(css).toContain('.zc-report-insight-grid');
    expect(css).toContain('.zc-report-driver-row');
    expect(css).toContain('.zc-report-chart-grid');
    expect(css).toContain('overscroll-behavior-inline: contain');
  });
});
