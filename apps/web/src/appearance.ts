/**
 * Appearance: which accent family and which mode the reader wants.
 *
 * Kept apart from the ledger on purpose. Appearance is a property of the device
 * and the person looking at it, not of the account's data: it is not synced, not
 * exported in a backup, and not part of the encrypted ledger. Storing it in
 * `localStorage` rather than in the ledger setting is what keeps a dark screen
 * from travelling to another device through a sync round-trip.
 *
 * `system` is a preference rather than a palette, so the resolution to a concrete
 * `light` / `dark` mode happens here, in one place, for every surface that needs
 * it (the ledger shell, the management console, the pre-login gates).
 */
import { themeTokens, type ThemeId, type ThemeMode, type ThemeModePreference } from './theme.js';

export const APPEARANCE_KEY = 'zichan.appearance.v1';
export const APPEARANCE_CHANGED_EVENT = 'zichan:appearance-changed';

export interface AppearancePreference {
  theme: ThemeId;
  mode: ThemeModePreference;
}

export const DEFAULT_APPEARANCE: AppearancePreference = { theme: 'terracotta', mode: 'system' };

const THEME_IDS: readonly ThemeId[] = ['terracotta', 'sage', 'plum'];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

export function isThemeModePreference(value: unknown): value is ThemeModePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Read a stored preference, ignoring anything that is not a known value.
 *
 * A hand-edited or half-written record must not leave the app with no palette at
 * all, so an unknown theme falls back to the default and an unknown mode to
 * `system` - the two choices that need no stored value to be meaningful.
 */
export function parseAppearancePreference(raw: string | null | undefined): AppearancePreference {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  try {
    const parsed = JSON.parse(raw) as { theme?: unknown; mode?: unknown };
    return {
      theme: isThemeId(parsed.theme) ? parsed.theme : DEFAULT_APPEARANCE.theme,
      mode: isThemeModePreference(parsed.mode) ? parsed.mode : DEFAULT_APPEARANCE.mode,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function serializeAppearancePreference(preference: AppearancePreference): string {
  return JSON.stringify({ version: 1, theme: preference.theme, mode: preference.mode });
}

/** Whether the operating system is currently asking for a dark screen. */
export function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
  } catch {
    return false;
  }
}

/** Turn the preference into the mode actually in effect. */
export function resolveThemeMode(preference: ThemeModePreference, prefersDark = systemPrefersDark()): ThemeMode {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

export function readAppearancePreference(): AppearancePreference {
  try {
    return parseAppearancePreference(globalThis.localStorage?.getItem(APPEARANCE_KEY) ?? null);
  } catch {
    // Storage can be unavailable in a hardened browser context; the default still renders.
    return { ...DEFAULT_APPEARANCE };
  }
}

export function writeAppearancePreference(patch: Partial<AppearancePreference>): AppearancePreference {
  const next: AppearancePreference = { ...readAppearancePreference(), ...patch };
  try {
    globalThis.localStorage?.setItem(APPEARANCE_KEY, serializeAppearancePreference(next));
  } catch {
    // A failed write must not stop the visible change; the next session falls back to the default.
  }
  globalThis.dispatchEvent?.(new CustomEvent(APPEARANCE_CHANGED_EVENT));
  return next;
}

/**
 * Subscribe to the operating system changing its mind about dark mode.
 *
 * Only useful while the preference is `system`, but subscribing unconditionally
 * keeps the caller from having to tear the listener down and rebuild it on every
 * switch. Returns an unsubscribe function; a runtime without `matchMedia` gets a
 * no-op so callers never have to guard.
 */
export function subscribeSystemMode(onChange: () => void): () => void {
  const query = (() => {
    try {
      return globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }
  })();
  if (!query) return () => undefined;
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

/**
 * Paint a palette onto an element, and remember what was there before.
 *
 * Applied to `document.documentElement` rather than to the app shell so the
 * palette also reaches what the shell cannot: the pre-login gates, the error
 * boundary (a sibling of the app, not a descendant) and the `body` background
 * behind a short page. The returned restore function puts the previous values
 * back, which is what lets a test - or a second app instance - clean up.
 */
export function applyThemeTokens(
  element: { style: { setProperty(name: string, value: string): void; getPropertyValue(name: string): string; removeProperty(name: string): void } },
  tokens: Record<string, string>,
  mode: ThemeMode,
): () => void {
  const previous = Object.fromEntries(Object.keys(tokens).map((name) => [name, element.style.getPropertyValue(name)]));
  for (const [name, value] of Object.entries(tokens)) element.style.setProperty(name, value);
  // Native controls, scrollbars and the caret follow `color-scheme`, not our tokens.
  const previousScheme = element.style.getPropertyValue('color-scheme');
  element.style.setProperty('color-scheme', mode);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value) element.style.setProperty(name, value);
      else element.style.removeProperty(name);
    }
    if (previousScheme) element.style.setProperty('color-scheme', previousScheme);
    else element.style.removeProperty('color-scheme');
  };
}

/** The tokens for one accent family in one mode. Re-exported so callers need one import. */
export function appearanceTokens(theme: ThemeId, mode: ThemeMode): Record<string, string> {
  return themeTokens(theme, mode);
}

/**
 * Keep the browser-chrome tint in step with the palette.
 *
 * The status bar of an installed web app is painted from `theme-color`, which is
 * a fixed literal in `index.html`. Left alone it stays cream above a dark page,
 * which reads as a rendering fault rather than as a theme.
 */
export function applyBrowserChrome(tokens: Record<string, string>, doc: Document | undefined = globalThis.document): void {
  const background = tokens['--bg'];
  if (!background || !doc) return;
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', background);
}
