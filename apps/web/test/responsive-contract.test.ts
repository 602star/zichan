import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const transactions = readFileSync(new URL('../src/screens/Transactions.tsx', import.meta.url), 'utf8');
const reports = readFileSync(new URL('../src/screens/Reports.tsx', import.meta.url), 'utf8');
const charts = readFileSync(new URL('../src/ui/charts.tsx', import.meta.url), 'utf8');
const reportInsights = readFileSync(new URL('../src/ui/TransactionReportInsights.tsx', import.meta.url), 'utf8');
const serverAdmin = readFileSync(new URL('../src/admin/AdminConsole.tsx', import.meta.url), 'utf8');
const ledgerEntry = readFileSync(new URL('../src/LedgerApp.tsx', import.meta.url), 'utf8');
const dialogShell = readFileSync(new URL('../src/ui/DialogShell.tsx', import.meta.url), 'utf8');
const errorBoundary = readFileSync(new URL('../src/ui/AppErrorBoundary.tsx', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/db/store.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/screens/Settings.tsx', import.meta.url), 'utf8');
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
    expect(store).toContain('复制诊断信息');
    expect(store).toContain("userSelect: 'text'");
    expect(store).toContain('aria-live="polite"');
    expect(main.indexOf('<AppErrorBoundary>')).toBeLessThan(main.indexOf('<LedgerApp />'));
    expect(ledgerEntry).toContain('<StoreProvider>');
    expect(main).not.toContain('<StoreProvider>');
  });

  it('keeps backup export actions observable instead of silently ignoring a click', () => {
    expect(settings).toContain('shareOrDownloadBackup');
    expect(settings).toContain('另存为…');
    expect(settings).toContain('保存中…');
    expect(settings).toContain('分享 / 下载失败');
    expect(app).toContain('if (isTauriRuntime())');
    expect(app).toContain("saveLedgerBackup(store, 'manual', '即时导出', 'portable')");
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
    expect(serverAdmin).toContain("overflowX: 'auto'");
    expect(serverAdmin).toContain('repeat(auto-fit, minmax(170px, 1fr))');
    expect(reports).toContain('zc-report-chart-grid');
    // The chart markup moved to `ui/charts.tsx` so both screens draw the same
    // shapes; the scroll container has to move with it.
    expect(charts).toContain('zc-report-chart-grid');
    expect(charts).toContain('zc-trend-grid');
    expect(css).toContain('.zc-chart-pair');
    expect(css).toContain('.zc-donut');
    expect(reportInsights).toContain('zc-report-insight-grid');
    expect(css).toContain('.zc-report-insight-grid');
    expect(css).toContain('.zc-report-driver-row');
    expect(css).toContain('.zc-report-chart-grid');
    expect(css).toContain('overscroll-behavior-inline: contain');
  });

  /*
   * The 日常收支 page stacks its two charts - composition first, trend second -
   * and never puts them side by side. Half a page is not enough for a ring plus
   * the legend that is its only reading (the 二级 names came out as ellipses),
   * so the shape is a contract rather than a preference.
   */
  it('stacks the 日常收支 charts, composition above trend, one per row', () => {
    expect(css).toContain('.zc-chart-stack');
    expect(css).toMatch(/\.zc-chart-stack\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(transactions).toContain('className="zc-chart-stack"');
    expect(transactions).not.toMatch(/id="transaction-charts"[^>]*className="zc-chart-pair"/);
    const composition = transactions.search(/<ExpenseCompositionCard/);
    const trend = transactions.search(/<Trend\s/);
    expect(composition).toBeGreaterThan(-1);
    expect(trend).toBeGreaterThan(-1);
    expect(composition, 'the composition must render above the trend').toBeLessThan(trend);
  });

  /*
   * A ring pair must also work with only one ring: with no 板块 selected there is
   * a single donut, and a fixed two-track grid stranded it in the left half of
   * the card. That is why the pair is `auto-fit` rather than two columns.
   */
  it('lets a lone ring take the whole row instead of half a card', () => {
    expect(css).toMatch(/\.zc-chart-pair\s*\{[^}]*repeat\(auto-fit,/);
  });

  /*
   * 图例行里名字列按自己的文字宽度取，而不是占满剩下的空间。占满时名字盒 444px、
   * 名字 52px，金额被推到行尾，「分类和金额隔开太远」。
   */
  it('sizes the donut legend name to its text so the amount stays next to it', () => {
    expect(css).toMatch(/\.zc-donut-legend-row\s*\{[^}]*grid-template-columns:\s*10px minmax\(0, max-content\) auto auto/);
    expect(css).toMatch(/\.zc-donut-legend-row\s*\{[^}]*justify-content:\s*start/);
  });

  // The touch baseline must not be tied to a width. Keying it off
  // `pointer: coarse` is what covers tablets (768-1199px) and landscape phones,
  // where a width-only rule silently reverted to 13px fields and 24px targets.
  it('keys the 44px and 16px touch baseline off coarse pointers, not a width', () => {
    const coarseBlocks = [...css.matchAll(/@media \(pointer: coarse\)[^{]*\{([\s\S]*?)\n\}/g)].map((match) => match[1]);
    expect(coarseBlocks.length).toBeGreaterThan(0);
    const coarse = coarseBlocks.join('\n');

    expect(coarse).toMatch(/min-height:\s*44px/);
    // The threshold is a token now, but it must still resolve to 16px: below it
    // Safari and Chrome on iOS zoom the whole page when a field takes focus.
    expect(coarse).toMatch(/font-size:\s*var\(--fs-input\)\s*!important/);
    expect(css).toMatch(/--fs-input:\s*16px;/);
    expect(coarse).toContain('select');
    expect(coarse).toContain('summary');
    // Checkboxes are only 13-18px; their tappable box is the wrapper.
    expect(coarse).toContain('.zc-check-row');
    expect(css).toContain('.zc-check-target');
    // `.zc-protection` sets `min-height: 36px` and `font: inherit` at class
    // specificity, so it must be re-floored explicitly.
    expect(coarse).toContain('.zc-protection button');
  });

  // `overflow-x: hidden` on <body> made <body> the scroll container, which both
  // hid real overflow and made window scrolling inert.
  it('keeps the viewport (not body) as the scroll container', () => {
    expect(css).toMatch(/html\s*\{[^}]*overflow-x:\s*clip/);
    expect(css).not.toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*hidden/);
    expect(css).toContain('@supports not (overflow: clip)');
  });

  it('locks the real scroller behind a dialog, not just body', () => {
    const scrollLock = readFileSync(new URL('../src/ui/body-scroll-lock.ts', import.meta.url), 'utf8');
    expect(scrollLock).toContain('acquireBodyScrollLock(document.documentElement)');
    expect(scrollLock).toContain('acquireBodyScrollLock(document.body)');
  });

  it('renders long ledger tables as cards on phones via the shared data-label pattern', () => {
    expect(css).toContain('.zc-card-table');
    expect(css).toContain('content: attr(data-label)');
    for (const file of ['../src/screens/History.tsx', '../src/screens/Reports.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, `${file} should opt its tables into the card layout`).toContain('className="zc-card-table"');
      expect(source).toContain('data-label=');
      expect(source).toContain('zc-card-table-empty');
    }
  });

  /*
   * Every inline `gridTemplateColumns` needs a class on the same element.
   * Without one there is no hook for a phone rule, so the grid silently keeps
   * desktop columns and gets clipped by the (previously) hidden overflow.
   * `repeat(auto-fit|auto-fill, ...)` grids are exempt: they already wrap.
   */
  it('never renders an inline fixed grid without a class hook', () => {
    const offenders: string[] = [];
    const walk = (relative: string) => {
      for (const entry of readdirSync(new URL(relative, import.meta.url), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (!entry.name.endsWith('.tsx')) continue;
        const source = readFileSync(new URL(child, import.meta.url), 'utf8');
        let index = source.indexOf('gridTemplateColumns');
        while (index !== -1) {
          const declaration = source.slice(index, index + 140);
          if (!/auto-fit|auto-fill/.test(declaration)) {
            // A generous window keeps spreading style objects (`{...card,
            // display: 'grid', ...}`) and long attribute lists covered.
            const before = source.slice(Math.max(0, index - 800), index);
            if (before.includes('style={{') && !before.includes('className')) {
              offenders.push(`${child}:${source.slice(0, index).split('\n').length}`);
            }
          }
          index = source.indexOf('gridTemplateColumns', index + 1);
        }
      }
    };
    walk('../src');
    expect(offenders.join('\n')).toBe('');
  });
});
