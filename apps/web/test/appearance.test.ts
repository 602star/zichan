import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  applyBrowserChrome,
  applyThemeTokens,
  appearanceTokens,
  parseAppearancePreference,
  readAppearancePreference,
  resolveThemeMode,
  serializeAppearancePreference,
  systemPrefersDark,
  writeAppearancePreference,
} from '../src/appearance.js';
import { DARK_THEMES, THEMES } from '../src/theme.js';

/*
 * Appearance is a device preference, so most of what can go wrong is a parsing
 * or storage question rather than a rendering one. These tests cover the three
 * decisions that would otherwise be invisible: what an unknown stored value
 * resolves to, whether `system` really follows the OS, and whether applying a
 * palette can be undone.
 */

class MemoryStorage {
  private values = new Map<string, string>();
  getItem = (key: string): string | null => this.values.get(key) ?? null;
  setItem = (key: string, value: string): void => { this.values.set(key, value); };
  removeItem = (key: string): void => { this.values.delete(key); };
  clear = (): void => { this.values.clear(); };
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('dark') ? matches : false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  stubMatchMedia(false);
});

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalMatchMedia) Object.defineProperty(globalThis, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(globalThis, 'matchMedia');
  vi.restoreAllMocks();
});

describe('appearance preference', () => {
  it('starts on the default family and follows the system', () => {
    expect(readAppearancePreference()).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE.mode).toBe('system');
  });

  it('round-trips a chosen family and mode', () => {
    writeAppearancePreference({ theme: 'plum', mode: 'dark' });
    expect(readAppearancePreference()).toEqual({ theme: 'plum', mode: 'dark' });
  });

  it('merges a partial change instead of resetting the other axis', () => {
    writeAppearancePreference({ theme: 'sage', mode: 'dark' });
    writeAppearancePreference({ mode: 'light' });
    expect(readAppearancePreference()).toEqual({ theme: 'sage', mode: 'light' });
  });

  /*
   * A hand-edited or half-written record must not leave the app without a
   * palette. Each bad field falls back on its own, so a corrupt `mode` does not
   * also discard a perfectly good `theme`.
   */
  it('ignores unknown values field by field', () => {
    expect(parseAppearancePreference('{"theme":"neon","mode":"dark"}')).toEqual({ theme: 'terracotta', mode: 'dark' });
    expect(parseAppearancePreference('{"theme":"sage","mode":"sepia"}')).toEqual({ theme: 'sage', mode: 'system' });
    expect(parseAppearancePreference('not json')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePreference(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePreference('{}')).toEqual(DEFAULT_APPEARANCE);
  });

  it('writes a versioned record so a later format can be recognised', () => {
    expect(JSON.parse(serializeAppearancePreference({ theme: 'sage', mode: 'dark' }))).toMatchObject({
      version: 1, theme: 'sage', mode: 'dark',
    });
  });

  it('survives storage being unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('storage disabled'); },
    });
    expect(readAppearancePreference()).toEqual(DEFAULT_APPEARANCE);
    // A failed write must not throw: the visible change still has to happen.
    expect(() => writeAppearancePreference({ mode: 'dark' })).not.toThrow();
  });
});

describe('theme mode resolution', () => {
  it('follows the operating system only when asked to', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    // An explicit choice outranks the system in both directions.
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
  });

  it('reads the system preference defensively', () => {
    stubMatchMedia(true);
    expect(systemPrefersDark()).toBe(true);
    Reflect.deleteProperty(globalThis, 'matchMedia');
    expect(systemPrefersDark()).toBe(false);
  });
});

describe('applying a palette', () => {
  /**
   * A stand-in for an element's inline style: methods *and* `style['--token']`
   * reads, because `applyThemeTokens` uses both.
   */
  function fakeElement(): {
    style: Record<string, unknown> & {
      setProperty(name: string, value: string): void;
      getPropertyValue(name: string): string;
      removeProperty(name: string): void;
    };
  } {
    const properties = new Map<string, string>();
    const style = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => {
        if (key === 'setProperty') return (name: string, value: string): void => { properties.set(name, value); };
        if (key === 'getPropertyValue') return (name: string): string => properties.get(name) ?? '';
        if (key === 'removeProperty') return (name: string): void => { properties.delete(name); };
        return typeof key === 'string' ? properties.get(key) : undefined;
      },
      has: (_target, key) => (typeof key === 'string' ? properties.has(key) : false),
    });
    return { style } as { style: Record<string, unknown> & { setProperty(name: string, value: string): void; getPropertyValue(name: string): string; removeProperty(name: string): void } };
  }

  it('paints every token of the chosen palette', () => {
    const element = fakeElement();
    applyThemeTokens(element, appearanceTokens('sage', 'dark'), 'dark');
    for (const [name, value] of Object.entries(DARK_THEMES.sage!)) {
      expect(element.style[name], `${name} was not applied`).toBe(value);
    }
    expect(element.style['color-scheme']).toBe('dark');
  });

  /*
   * The dark palette must be genuinely dark. A token that stayed light would make
   * a label invisible against the surface it sits on, and the maps are plain
   * objects, so nothing but a check like this notices.
   */
  it('keeps the dark palettes darker than their light twins', () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const channel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    for (const id of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
      for (const token of ['--bg', '--surface', '--surface-2']) {
        expect(luminance(DARK_THEMES[id]![token]!), `${id} ${token} is not dark`).toBeLessThan(luminance(THEMES[id]![token]!));
      }
      // Foreground text has to stay readable on the surface behind it.
      expect(luminance(DARK_THEMES[id]!['--fg']!)).toBeGreaterThan(luminance(DARK_THEMES[id]!['--bg']!));
    }
  });

  it('restores whatever the element had before', () => {
    const element = fakeElement();
    element.style.setProperty('--bg', '#abcdef');
    const restore = applyThemeTokens(element, appearanceTokens('plum', 'dark'), 'dark');
    expect(element.style['--bg']).toBe(DARK_THEMES.plum!['--bg']);
    restore();
    expect(element.style['--bg']).toBe('#abcdef');
    expect(element.style['color-scheme']).toBeUndefined();
  });

  it('keeps the browser-chrome tint in step with the page', () => {
    const meta = { content: '', setAttribute: (name: string, value: string) => { meta.content = value; } };
    const doc = { querySelector: (selector: string) => (selector.includes('theme-color') ? meta : null) } as unknown as Document;
    applyBrowserChrome(appearanceTokens('terracotta', 'dark'), doc);
    expect(meta.content).toBe(DARK_THEMES.terracotta!['--bg']);
    // No meta tag is not an error: the palette simply is not reflected in chrome.
    expect(() => applyBrowserChrome(appearanceTokens('sage', 'light'), { querySelector: () => null } as unknown as Document)).not.toThrow();
  });
});
