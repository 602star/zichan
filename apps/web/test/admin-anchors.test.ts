import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sectionId } from '../src/admin/ui.js';

/*
 * In-page navigation.
 *
 * A jump list is only useful if every entry resolves. Its ids are derived from
 * panel titles by one helper, so the thing worth pinning is that the helper is
 * deterministic and produces something usable as a fragment - and that no page
 * links to a section it does not render.
 */

const PAGES = ['OverviewPage', 'SecurityPage', 'UserDetailPage', 'LogsPage', 'UsersPage', 'SessionsPage'];
const readPage = (name: string): string => readFileSync(new URL(`../src/admin/${name}.tsx`, import.meta.url), 'utf8');

describe('section anchors', () => {
  it('derives a stable fragment from a title', () => {
    expect(sectionId('我的账号密码')).toBe('section-我的账号密码');
    // Punctuation becomes a separator rather than a percent-encoded run.
    expect(sectionId('容量与配额 (v2)')).toBe('section-容量与配额-v2');
    expect(sectionId('  A B  ')).toBe('section-a-b');
    // A title made only of punctuation still has to yield a usable id.
    expect(sectionId('——')).toBe('section');
  });

  it('is idempotent, so re-rendering cannot produce a new target', () => {
    const title = '我的两步验证';
    expect(sectionId(title)).toBe(sectionId(title));
  });

  /*
   * A `Panel` gives itself an id from its title; the index references the same
   * helper. If a page listed a section it does not render, the link would look
   * correct and do nothing, which is the failure this catches.
   */
  it('never links to a section its page does not render', () => {
    for (const page of PAGES) {
      const source = readPage(page);
      const referenced = [...source.matchAll(/sectionId\('([^']+)'\)/g)].map((match) => match[1]!);
      for (const title of referenced) {
        expect(source, `${page} links to 「${title}」 but renders no such panel`).toContain(`<Panel title="${title}"`);
      }
    }
  });

  it('offers a jump list only where there is enough to scan', () => {
    // The component itself declines below three sections; pages with fewer than
    // three panels must therefore not reference it at all.
    for (const page of PAGES) {
      const source = readPage(page);
      const usesIndex = source.includes('<PanelIndex');
      const panels = (source.match(/<Panel\s/g) ?? []).length;
      if (usesIndex) expect(panels, `${page} shows a jump list for only ${panels} panels`).toBeGreaterThanOrEqual(3);
    }
  });

  it('renders the index above the panels, not after them', () => {
    for (const page of PAGES) {
      const source = readPage(page);
      const index = source.indexOf('<PanelIndex');
      if (index < 0) continue;
      const firstPanel = source.indexOf('<Panel ');
      expect(index, `${page} renders its jump list after its first panel`).toBeLessThan(firstPanel);
    }
  });
});
