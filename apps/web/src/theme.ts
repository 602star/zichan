/**
 * 大福帳 · 墨与朱. The persisted theme ids select paper tints, while vermilion
 * remains the sole action accent. Income, expense, warning and chart slots each
 * have separate semantic tokens. Light and dark maps carry identical keys.
 */
export type ThemeId = 'terracotta' | 'sage' | 'plum';

/** Whether the palette is light or dark. `system` is a preference, not a palette. */
export type ThemeMode = 'light' | 'dark';

/** What the reader asked for. `system` follows the operating system setting. */
export type ThemeModePreference = ThemeMode | 'system';

/** The ordered categorical slots a composition chart may use. */
export const CATEGORY_COLORS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)'];

/*
 * Shadows and the dialog scrim, per mode rather than per accent family.
 *
 * A dark surface needs a different shadow rather than a darker one: a translucent
 * black drop shadow is invisible on a near-black page, so dark mode uses a deeper
 * black, and the scrim has to be denser to separate a dialog from the content
 * behind it. These live outside the per-theme maps because the choice belongs to
 * the mode, not to the accent.
 */
const SHADOWS: Record<ThemeMode, Record<string, string>> = {
  light: {
    '--shadow-md': '0 18px 40px rgba(46, 36, 27, .16)',
    '--shadow-lg': '0 24px 80px rgba(46, 36, 27, .12)',
    '--shadow-up': '0 -10px 30px rgba(15, 23, 42, .08)',
    '--shadow-up-strong': '0 -22px 64px rgba(15, 23, 42, .24)',
    '--scrim': 'rgba(20, 16, 12, 0.38)',
  },
  dark: {
    '--shadow-md': '0 18px 40px rgba(0, 0, 0, .55)',
    '--shadow-lg': '0 24px 80px rgba(0, 0, 0, .6)',
    '--shadow-up': '0 -10px 30px rgba(0, 0, 0, .5)',
    '--shadow-up-strong': '0 -22px 64px rgba(0, 0, 0, .62)',
    '--scrim': 'rgba(0, 0, 0, .58)',
  },
};

/** The bucket that collects every category past the visible slots. */
export const OTHER_CATEGORY_COLOR = 'var(--cat-other)';

// The historical theme ids remain stable for saved preferences. Each now selects
// a paper tint inside the same ink-and-vermilion visual language.
const INK_LIGHT_BASE = {
  '--fg': '#211d18', '--fg-muted': '#56514b', '--fg-subtle': '#625d56',
  '--accent': '#b63226', '--accent-soft': '#f2ded9',
  '--positive': '#2b6079', '--negative': '#a72f24', '--warning': '#76531c',
  '--on-accent': '#ffffff', '--danger': '#a72f24', '--text-muted': '#56514b',
  '--ok-surface': '#e5edf0', '--warn-surface': '#f3ead9', '--danger-surface': '#f4e0dc',
  '--sidebar-bg': '#24221f', '--sidebar-fg': '#e8e3d9',
  '--sidebar-muted': '#b7afa4', '--sidebar-active': '#38312b',
  '--cat-1': '#2b6079', '--cat-2': '#697851', '--cat-3': '#a0793d',
  '--cat-4': '#7e6173', '--cat-5': '#696877', '--cat-6': '#617b78',
  '--cat-other': '#969188',
};
const INK_DARK_BASE = {
  '--fg': '#f1eee6', '--fg-muted': '#c7c0b4', '--fg-subtle': '#b6ad9f',
  '--accent': '#ee7868', '--accent-soft': '#4b2925',
  '--positive': '#8ec5dc', '--negative': '#f18c78', '--warning': '#e1b371',
  '--on-accent': '#211b18', '--danger': '#f18c78', '--text-muted': '#c7c0b4',
  '--ok-surface': '#20343d', '--warn-surface': '#3a3022', '--danger-surface': '#412824',
  '--sidebar-bg': '#141413', '--sidebar-fg': '#e9e4db',
  '--sidebar-muted': '#b8afa4', '--sidebar-active': '#302823',
  '--cat-1': '#8ec5dc', '--cat-2': '#b3c98e', '--cat-3': '#d6b77a',
  '--cat-4': '#c7a4b7', '--cat-5': '#a7a5c5', '--cat-6': '#9bbfbb',
  '--cat-other': '#9e998f',
};
const INK_LIGHT_PAPER: Record<ThemeId, Record<string, string>> = {
  terracotta: { '--bg': '#ebe8df', '--surface': '#faf9f5', '--surface-2': '#f1efe8', '--border': '#d3cec2', '--border-strong': '#bcb4a5', '--surface-muted': '#e9e5dc' },
  sage: { '--bg': '#e7e9e5', '--surface': '#f9faf6', '--surface-2': '#eef0eb', '--border': '#ccd3ca', '--border-strong': '#b5bfb3', '--surface-muted': '#e3e8e1' },
  plum: { '--bg': '#eae7e9', '--surface': '#fbf8fa', '--surface-2': '#f1edf0', '--border': '#d5cbd2', '--border-strong': '#bfb2bc', '--surface-muted': '#e9e2e7' },
};
const INK_DARK_PAPER: Record<ThemeId, Record<string, string>> = {
  terracotta: { '--bg': '#1b1b1a', '--surface': '#262521', '--surface-2': '#302e2a', '--border': '#48443e', '--border-strong': '#5b554d', '--surface-muted': '#302d29' },
  sage: { '--bg': '#191d1b', '--surface': '#232925', '--surface-2': '#2b332d', '--border': '#414b43', '--border-strong': '#566157', '--surface-muted': '#29312b' },
  plum: { '--bg': '#1d1a1d', '--surface': '#292329', '--surface-2': '#342c33', '--border': '#4c414b', '--border-strong': '#60525e', '--surface-muted': '#302831' },
};

export const THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: { ...INK_LIGHT_BASE, ...INK_LIGHT_PAPER.terracotta },
  sage: { ...INK_LIGHT_BASE, ...INK_LIGHT_PAPER.sage },
  plum: { ...INK_LIGHT_BASE, ...INK_LIGHT_PAPER.plum },
};

/**
 * Dark paper is re-inked for contrast rather than numerically inverted.
 */
export const DARK_THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: { ...INK_DARK_BASE, ...INK_DARK_PAPER.terracotta },
  sage: { ...INK_DARK_BASE, ...INK_DARK_PAPER.sage },
  plum: { ...INK_DARK_BASE, ...INK_DARK_PAPER.plum },
};

export const ACCENTS: Record<ThemeId, string> = {
  terracotta: '#b63226', sage: '#b63226', plum: '#b63226',
};

export const DARK_ACCENTS: Record<ThemeId, string> = {
  terracotta: '#ee7868', sage: '#ee7868', plum: '#ee7868',
};

export const THEME_NAMES: Record<ThemeId, string> = {
  terracotta: '文献纸 · 墨朱', sage: '青灰纸 · 墨朱', plum: '紫灰纸 · 墨朱',
};

export const THEME_MODE_NAMES: Record<ThemeModePreference, string> = {
  light: '浅色', dark: '深色', system: '跟随系统',
};

/** The palette for one paper tint in one mode. */
export function themeTokens(theme: ThemeId, mode: ThemeMode): Record<string, string> {
  return { ...(mode === 'dark' ? DARK_THEMES[theme] : THEMES[theme]), ...SHADOWS[mode] };
}

/** The shared vermilion action swatch for one mode. */
export function themeAccent(theme: ThemeId, mode: ThemeMode): string {
  return mode === 'dark' ? DARK_ACCENTS[theme] : ACCENTS[theme];
}

export const FONT_FAMILY =
  "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif";
