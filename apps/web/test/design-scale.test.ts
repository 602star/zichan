import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DARK_THEMES, THEMES } from '../src/theme.js';

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
    // The donut legend rows are compact under a mouse, so they must be put back
    // on the touch floor for a finger.
    expect(coarse).toContain('.zc-donut-legend-row');
    expect(coarse).toMatch(/\.zc-icon-options button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/);
  });

  /*
   * Composition charts paint a category per slice. Those colours cannot be the
   * semantic ones - `--negative` already means 「支出」 on the same screens - so
   * the slots are real tokens, and every theme needs them: a theme that skips
   * one leaves a slice transparent.
   */
  it('paints the page canvas from the palette, not the user agent default', () => {
    // `--bg` on the app shell only covers the shell's own height; everything
    // below a short page is the root element's background, which defaults to
    // white. A dark screen that stops at the last row of content reads as a
    // rendering fault, so the root has to carry the palette too.
    expect(css).toMatch(/html \{\s*background: var\(--bg\);/);
    expect(css).toMatch(/body \{\s*background: inherit;/);
    expect(css).toMatch(/body \{[^}]*color: var\(--text-primary\)/);
  });

  it('declares a colour scheme so native chrome follows the palette', () => {
    // Scrollbars, the caret and a native control's focus ring follow
    // `color-scheme`, not our tokens.
    expect(css).toMatch(/:root \{[\s\S]*?color-scheme: light;/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*?color-scheme: dark;/);
  });

  it('gives every theme values for the categorical slots', () => {
    const slots = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-other'];
    for (const slot of slots) {
      expect(css, `${slot} must be declared on :root`).toContain(`${slot}:`);
    }
    for (const [id, theme] of Object.entries(THEMES)) {
      for (const slot of slots) {
        expect(theme[slot], `${id} is missing ${slot}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
    // A dark palette that skipped a slot would leave a chart slice transparent
    // on exactly the screens where the legend still lists it.
    for (const [id, theme] of Object.entries(DARK_THEMES)) {
      for (const slot of slots) {
        expect(theme[slot], `dark ${id} is missing ${slot}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  /*
   * A dark palette has to declare the same token names as its light twin, or the
   * mode switch leaves whatever the light theme set. The two maps are separate
   * objects, so nothing else keeps them in step.
   */
  it('declares the same tokens in both modes for every theme', () => {
    for (const id of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
      const light = Object.keys(THEMES[id]!).sort();
      const dark = Object.keys(DARK_THEMES[id]!).sort();
      expect(dark, `${id} dark palette does not match its light token list`).toEqual(light);
    }
  });

  /*
   * The management console referred to these names before anything declared them,
   * so every reference silently fell through to a hardcoded light literal - which
   * is what made the console unable to follow a dark screen at all.
   */
  it('declares every token the console used to fall back on', () => {
    for (const token of [
      '--fs-sm', '--text-muted', '--surface-muted', '--ok-surface', '--warn-surface',
      '--danger-surface', '--danger', '--border-strong', '--on-accent',
      '--shadow-md', '--shadow-lg', '--shadow-up', '--shadow-up-strong', '--scrim',
    ]) {
      expect(css, `${token} must be declared on :root`).toContain(`${token}:`);
    }
    // Every one of them also has to exist per theme and per mode, or a themed
    // badge or shadow keeps the default palette's value.
    for (const [id, theme] of Object.entries(THEMES)) {
      for (const token of ['--on-accent', '--danger', '--text-muted', '--surface-muted', '--ok-surface', '--warn-surface', '--danger-surface', '--border-strong']) {
        expect(theme[token], `${id} is missing ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  /*
   * The pre-hydration block is what stops a dark screen from flashing cream while
   * the bundle loads. It duplicates one palette, so it can drift from `theme.ts`
   * without anything failing - unless it is compared here.
   */
  it('keeps the pre-hydration dark defaults in step with the default theme', () => {
    const block = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}/.exec(css);
    expect(block, 'the pre-hydration dark block must exist').toBeTruthy();
    // Both custom properties and plain declarations (notably `color-scheme`) are
    // captured, because the block has to state the mode as well as the palette.
    const declared = Object.fromEntries(
      [...block![1].matchAll(/(^|\s)([a-z-]+[0-9]*):\s*([^;\n]+);/g)].map((m) => [m[2], m[3].trim()]),
    );
    // Shadows and `color-scheme` are mode-level, not palette-level; the palette
    // tokens are the ones that must agree with `DARK_THEMES.terracotta`.
    for (const [token, value] of Object.entries(DARK_THEMES.terracotta!)) {
      if (token.startsWith('--shadow') || token === '--scrim') continue;
      expect(declared[token], `${token} differs between styles.css and theme.ts`).toBe(value);
    }
    expect(declared['color-scheme']).toBe('dark');
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
    /*
     * The token pass did not reduce this: almost every remaining declaration
     * overrides an inline `gridTemplateColumns`, `width`, `white-space` or
     * `padding` that a phone-only rule has to beat, plus `display: none` and
     * the reduced-motion reset. Clearing them means moving that layout out of
     * inline styles and into classes, which is tracked separately - so for now
     * the budget only has to hold.
     */
    expect(count).toBeLessThanOrEqual(151);
  });

  /*
   * This is the invariant that actually restores hierarchy, and the reason the
   * audit found 62% of text bold: small auxiliary text was shouting as loudly
   * as the numbers it described. Size and colour carry emphasis now, so a
   * label, chip or caption must never be bold.
   */
  it('never bolds small auxiliary text', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const match of file.text.matchAll(/\{[^{}]*\}/g)) {
        const block = match[0];
        const small = /fontSize:\s*'var\(--fs-(meta|caption)\)'/.test(block);
        if (small && /fontWeight:\s*'var\(--fw-bold\)'/.test(block)) {
          offenders.push(`${file.path}: ${block.slice(0, 90)}`);
        }
      }
    }
    expect(offenders.join('\n'), 'meta and caption text uses --fw-medium at most').toBe('');
  });

  it('declares every heading on the scale instead of falling back to the UA size', () => {
    // `<h3>` defaulted to 18.72px, a size belonging to no scale step.
    expect(css).toMatch(/h1,\s*\n?h2,\s*\n?h3,\s*\n?h4\s*\{[\s\S]*?font-size:\s*var\(--fs-title\)/);
  });
});
