import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Batch 0 of the visual-density plan: the scale must exist in CSS, and every
 * call site must point at it.
 *
 * These are the guardrails that keep the collapse from quietly undoing itself.
 * Without them the next feature adds a 14px size, a 850 weight and an 11px
 * radius, and six months later the audit finds 27 sizes again.
 */

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/ui/styles.ts', import.meta.url), 'utf8');

const SRC = new URL('../src/', import.meta.url);

const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory()
    ? walk(new URL(`${entry.name}/`, dir))
    : [new URL(entry.name, dir)]));

const sourceFiles = walk(SRC).filter((file) => /\.tsx?$/.test(file.pathname));
const sources = sourceFiles.map((file) => ({
  path: file.pathname.split(/[\\/]/).slice(-2).join('/'),
  full: file.pathname,
  text: readFileSync(file, 'utf8'),
}));

/** Collect every inline declaration of `property` across the app source. */
const inlineValues = (property: string): { value: string; where: string }[] => {
  const found: { value: string; where: string }[] = [];
  for (const file of sources) {
    for (const match of file.text.matchAll(new RegExp(`${property}:\\s*([^,}\\n]+)`, 'g'))) {
      found.push({ value: match[1].trim(), where: file.path });
    }
  }
  return found;
};

/** Every declaration of `property` in styles.css outside the `:root` token block. */
const cssBody = css.slice(css.indexOf('* {'));
const cssValues = (property: string): string[] =>
  [...cssBody.matchAll(new RegExp(`${property}:\\s*([^;\\n]+)`, 'g'))].map((m) => m[1].trim());

describe('design scale contract', () => {
  it('defines the whole scale as custom properties on :root', () => {
    for (const token of [
      '--fs-meta', '--fs-caption', '--fs-body', '--fs-title', '--fs-heading', '--fs-display', '--fs-hero',
      '--fw-regular', '--fw-medium', '--fw-bold',
      '--r-sm', '--r-md', '--r-lg', '--r-pill',
      '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6',
      '--text-primary', '--text-secondary', '--text-tertiary',
    ]) {
      expect(css, `${token} must be declared`).toContain(`${token}:`);
    }
    // The palette is mirrored here so CSS can stand alone, but the theme still
    // overrides it at runtime.
    expect(css).toMatch(/--accent:\s*#/);
  });

  // 27 ad-hoc sizes and 9 weights are what made every string compete for
  // attention. The scale only works if call sites cannot bypass it. `0` is
  // allowed: a square corner is not a scale value.
  it('never sets a raw font size, weight, or radius inline', () => {
    for (const property of ['fontSize', 'fontWeight', 'borderRadius']) {
      const offenders = inlineValues(property)
        .filter(({ value }) => !value.includes('var(--') && value !== '0')
        .map(({ value, where }) => `${where}: ${property}: ${value}`);
      expect(offenders.join('\n'), `${property} must use a token`).toBe('');
    }
  });

  it('never sets a raw font size, weight, or radius in CSS outside :root', () => {
    for (const property of ['font-size', 'font-weight', 'border-radius']) {
      const offenders = cssValues(property)
        .map((value) => value.replace(/\s*!important$/, '').trim())
        .filter((value) => value !== '0' && !value.includes('var(--'))
        .map((value) => `${property}: ${value}`);
      expect(offenders.join('\n'), `${property} must use a token`).toBe('');
    }
  });

  // 62.7% of text blocks were bold, so nothing was emphasised. Three weights
  // and a size/colour hierarchy make the bold ones mean something again.
  it('uses only the three named weights', () => {
    expect(styles).toContain('--fw-regular');
    expect(styles).toContain('--fw-medium');
    expect(styles).toContain('--fw-bold');
  });

  it('keeps form controls off the browser default font size', () => {
    expect(css).toMatch(/input,[\s\S]*?button\s*\{[\s\S]*?font-size:\s*var\(--fs-body\)/);
  });

  it('provides the shared component vocabulary', () => {
    for (const cls of [
      '.zc-card', '.zc-card.is-flush', '.zc-section', '.zc-section-title', '.zc-meta', '.zc-caption',
      '.zc-btn', '.zc-btn--primary', '.zc-btn--ghost', '.zc-btn--danger', '.zc-btn--sm',
      '.zc-tabs', '.zc-tab', '.zc-field', '.zc-summary-bar', '.zc-menu', '.zc-menu-item',
    ]) {
      expect(css, `${cls} must exist`).toContain(cls);
    }
  });

  /*
   * A class-based `min-height` outranks the bare `button` touch baseline, which
   * is exactly how `.zc-protection` regressed before. Any component class that
   * sets a height must be re-floored for coarse pointers.
   */
  it('re-floors component buttons for coarse pointers', () => {
    const coarse = [...css.matchAll(/@media \(pointer: coarse\)[^{]*\{([\s\S]*?)\n\}/g)]
      .map((match) => match[1]).join('\n');
    expect(coarse).toContain('.zc-btn');
    expect(coarse).toContain('.zc-tab');
    expect(coarse).toMatch(/\.zc-btn--sm\s*\{[^}]*min-height:\s*36px/);
  });

  /*
   * Buttons used to be re-declared per screen; that is why the same "primary
   * action" looked different on every page. Each of these names existed in at
   * least one screen and now resolves to a single definition in `ui/styles.ts`.
   * A screen may still declare layout objects, but not another button.
   */
  it('keeps button styles in one place', () => {
    const legacy = [
      'outline', 'primary', 'button', 'smallButton', 'primaryButton', 'outlineButton',
      'outlineBtn', 'primaryBtn', 'ghostBtn', 'secondaryButton', 'smallLabel', 'dangerLink',
      'iconButton', 'linkButton',
    ];
    const offenders = sources
      .filter((file) => !file.path.endsWith('ui/styles.ts'))
      .flatMap((file) => legacy
        .filter((name) => {
          const match = file.text.match(
            new RegExp(`const ${name}(\\s*:\\s*CSSProperties)?\\s*=\\s*\\{([\\s\\S]{0,240})`),
          );
          // A plain object that happens to be called `primary` is not a button;
          // the button signature is the pointer cursor.
          return Boolean(match) && /cursor:\s*'pointer'/.test(match[2]);
        })
        .map((name) => `${file.path}: const ${name} = { ... }`));
    expect(offenders.join('\n'), 'define buttons in ui/styles.ts and import them').toBe('');
  });

  it('keeps the !important budget from growing', () => {
    const count = (css.match(/!important/g) ?? []).length;
    // Down from 148 before the token pass. The remainder are the coarse-pointer
    // control floor and phone-only table cell padding.
    expect(count).toBeLessThanOrEqual(155);
  });
});
