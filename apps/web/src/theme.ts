/**
 * 大福帳 · 墨与朱. Each persisted theme id selects a bookbinding combination:
 * bookcloth sidebar (`--sidebar-*`), ledger paper (`--bg`, `--surface`, rules),
 * and ink temperature (`--fg`, `--fg-muted`, `--fg-subtle`). Vermilion remains
 * the sole action and seal accent; income indigo, expense crimson, warning
 * ochre and categorical mineral pigments stay semantically consistent across
 * every binding. Light and dark maps carry identical keys.
 */
export type ThemeId = 'terracotta' | 'indigo' | 'sage' | 'plum' | 'ochre' | 'ivory';

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
    '--shadow-sm': '0 4px 14px rgba(46, 36, 27, .10)',
    '--shadow-md': '0 18px 40px rgba(46, 36, 27, .16)',
    '--shadow-lg': '0 24px 80px rgba(46, 36, 27, .12)',
    '--shadow-up': '0 -10px 30px rgba(15, 23, 42, .08)',
    '--shadow-up-strong': '0 -22px 64px rgba(15, 23, 42, .24)',
    '--scrim': 'rgba(20, 16, 12, 0.38)',
  },
  dark: {
    '--shadow-sm': '0 4px 14px rgba(0, 0, 0, .42)',
    '--shadow-md': '0 18px 40px rgba(0, 0, 0, .55)',
    '--shadow-lg': '0 24px 80px rgba(0, 0, 0, .6)',
    '--shadow-up': '0 -10px 30px rgba(0, 0, 0, .5)',
    '--shadow-up-strong': '0 -22px 64px rgba(0, 0, 0, .62)',
    '--scrim': 'rgba(0, 0, 0, .58)',
  },
};

/** The bucket that collects every category past the visible slots. */
export const OTHER_CATEGORY_COLOR = 'var(--cat-other)';

// Shared semantic inks and mineral chart pigments. Each binding supplies its
// own bookcloth sidebar, paper tones, and ink temperature on top of this base.
const INK_LIGHT_SEMANTIC = {
  '--accent': '#b63226', '--accent-soft': '#f2ded9',
  '--positive': '#2b6079', '--negative': '#a72f24', '--warning': '#76531c',
  '--on-accent': '#ffffff', '--danger': '#a72f24',
  '--ok-surface': '#e5edf0', '--warn-surface': '#f3ead9', '--danger-surface': '#f4e0dc',
  '--cat-1': '#2b6079', '--cat-2': '#697851', '--cat-3': '#a0793d',
  '--cat-4': '#7e6173', '--cat-5': '#696877', '--cat-6': '#617b78',
  '--cat-other': '#969188',
};
const INK_DARK_SEMANTIC = {
  '--accent': '#ee7868', '--accent-soft': '#4b2925',
  '--positive': '#8ec5dc', '--negative': '#f18c78', '--warning': '#e1b371',
  '--on-accent': '#211b18', '--danger': '#f18c78',
  '--ok-surface': '#20343d', '--warn-surface': '#3a3022', '--danger-surface': '#412824',
  '--cat-1': '#8ec5dc', '--cat-2': '#b3c98e', '--cat-3': '#d6b77a',
  '--cat-4': '#c7a4b7', '--cat-5': '#a7a5c5', '--cat-6': '#9bbfbb',
  '--cat-other': '#9e998f',
};

const LIGHT_BINDINGS: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--bg': '#ebe7dc', '--surface': '#faf8f3', '--surface-2': '#f2efe6', '--surface-muted': '#e8e3d8',
    '--border': '#d2cbbd', '--border-strong': '#b7ae9d',
    '--fg': '#211d18', '--fg-muted': '#565048', '--fg-subtle': '#615b52', '--text-muted': '#565048',
    '--sidebar-bg': '#25211d', '--sidebar-fg': '#ebe5da', '--sidebar-muted': '#b8afa2', '--sidebar-active': '#3a322b', '--sidebar-brand': '#ee7868',
  },
  indigo: {
    '--bg': '#e8ecf1', '--surface': '#f8f9fb', '--surface-2': '#eef1f6', '--surface-muted': '#e1e6ed',
    '--border': '#c8d0db', '--border-strong': '#adb7c6',
    '--fg': '#1b212a', '--fg-muted': '#4c5563', '--fg-subtle': '#56606f', '--text-muted': '#4c5563',
    '--sidebar-bg': '#1a2634', '--sidebar-fg': '#e6ecf2', '--sidebar-muted': '#a9b7c6', '--sidebar-active': '#28394c', '--sidebar-brand': '#f07c6b',
  },
  sage: {
    '--bg': '#e3e8e2', '--surface': '#f6f8f5', '--surface-2': '#ebf0ea', '--surface-muted': '#dce3db',
    '--border': '#c3cdc2', '--border-strong': '#a9b6a8',
    '--fg': '#1c231e', '--fg-muted': '#4a564d', '--fg-subtle': '#546158', '--text-muted': '#4a564d',
    '--sidebar-bg': '#1c2621', '--sidebar-fg': '#e5ece7', '--sidebar-muted': '#a9b8ae', '--sidebar-active': '#2a3831', '--sidebar-brand': '#ee7868',
  },
  plum: {
    '--bg': '#eae5ea', '--surface': '#fbf8fb', '--surface-2': '#f2edf2', '--surface-muted': '#e5dde5',
    '--border': '#d2c6d2', '--border-strong': '#b9aab9',
    '--fg': '#241c24', '--fg-muted': '#594d59', '--fg-subtle': '#635663', '--text-muted': '#594d59',
    '--sidebar-bg': '#261d27', '--sidebar-fg': '#eee6ee', '--sidebar-muted': '#bcaebc', '--sidebar-active': '#392b3a', '--sidebar-brand': '#f07c6b',
  },
  ochre: {
    '--bg': '#ede6d8', '--surface': '#fbf8f2', '--surface-2': '#f4eee2', '--surface-muted': '#e8dfd0',
    '--border': '#d3c7b2', '--border-strong': '#b8aa92',
    '--fg': '#241d15', '--fg-muted': '#574c3f', '--fg-subtle': '#5f5346', '--text-muted': '#574c3f',
    '--sidebar-bg': '#281f18', '--sidebar-fg': '#eee6da', '--sidebar-muted': '#bdaea0', '--sidebar-active': '#3d3026', '--sidebar-brand': '#f07c6b',
  },
  ivory: {
    '--bg': '#f0f0ee', '--surface': '#ffffff', '--surface-2': '#f5f5f3', '--surface-muted': '#ebebea',
    '--border': '#d6d6d2', '--border-strong': '#babab4',
    '--fg': '#171716', '--fg-muted': '#52524f', '--fg-subtle': '#5e5e5a', '--text-muted': '#52524f',
    '--sidebar-bg': '#1a1a19', '--sidebar-fg': '#f0f0ed', '--sidebar-muted': '#b5b5b0', '--sidebar-active': '#2d2d2b', '--sidebar-brand': '#ee7868',
  },
};

const DARK_BINDINGS: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--bg': '#1b1a18', '--surface': '#262420', '--surface-2': '#312e29', '--surface-muted': '#302d28',
    '--border': '#49443d', '--border-strong': '#5d564d',
    '--fg': '#f2eee6', '--fg-muted': '#c9c1b4', '--fg-subtle': '#b7aea0', '--text-muted': '#c9c1b4',
    '--sidebar-bg': '#141311', '--sidebar-fg': '#ece6dc', '--sidebar-muted': '#b8afa2', '--sidebar-active': '#312923', '--sidebar-brand': '#ee7868',
  },
  indigo: {
    '--bg': '#161a20', '--surface': '#20262f', '--surface-2': '#2a313c', '--surface-muted': '#28303b',
    '--border': '#3f4958', '--border-strong': '#536073',
    '--fg': '#eef2f6', '--fg-muted': '#bdc7d4', '--fg-subtle': '#a9b5c4', '--text-muted': '#bdc7d4',
    '--sidebar-bg': '#101720', '--sidebar-fg': '#e8eef4', '--sidebar-muted': '#a6b5c6', '--sidebar-active': '#223142', '--sidebar-brand': '#f07c6b',
  },
  sage: {
    '--bg': '#171c19', '--surface': '#212824', '--surface-2': '#2a332e', '--surface-muted': '#28312c',
    '--border': '#3f4b44', '--border-strong': '#536259',
    '--fg': '#edf2ee', '--fg-muted': '#bcc8bf', '--fg-subtle': '#a9b7ad', '--text-muted': '#bcc8bf',
    '--sidebar-bg': '#111714', '--sidebar-fg': '#e7eee9', '--sidebar-muted': '#a8b8ae', '--sidebar-active': '#24322b', '--sidebar-brand': '#ee7868',
  },
  plum: {
    '--bg': '#1c181d', '--surface': '#272128', '--surface-2': '#322a33', '--surface-muted': '#2f2730',
    '--border': '#4b3f4c', '--border-strong': '#605161',
    '--fg': '#f3edf3', '--fg-muted': '#cabdca', '--fg-subtle': '#b8aab8', '--text-muted': '#cabdca',
    '--sidebar-bg': '#151116', '--sidebar-fg': '#efe8ef', '--sidebar-muted': '#baaeba', '--sidebar-active': '#332534', '--sidebar-brand': '#f07c6b',
  },
  ochre: {
    '--bg': '#1c1915', '--surface': '#27231d', '--surface-2': '#322d25', '--surface-muted': '#302b23',
    '--border': '#4b4338', '--border-strong': '#605648',
    '--fg': '#f3ede3', '--fg-muted': '#cbc0b0', '--fg-subtle': '#b9ad9c', '--text-muted': '#cbc0b0',
    '--sidebar-bg': '#15120e', '--sidebar-fg': '#efe8dd', '--sidebar-muted': '#bbaea0', '--sidebar-active': '#332920', '--sidebar-brand': '#f07c6b',
  },
  ivory: {
    '--bg': '#141414', '--surface': '#1f1f1e', '--surface-2': '#2a2a28', '--surface-muted': '#272725',
    '--border': '#42423f', '--border-strong': '#575753',
    '--fg': '#f5f5f2', '--fg-muted': '#c4c4be', '--fg-subtle': '#b0b0aa', '--text-muted': '#c4c4be',
    '--sidebar-bg': '#0e0e0e', '--sidebar-fg': '#f0f0ed', '--sidebar-muted': '#b2b2ac', '--sidebar-active': '#262624', '--sidebar-brand': '#ee7868',
  },
};

export const THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: { ...INK_LIGHT_SEMANTIC, ...LIGHT_BINDINGS.terracotta },
  indigo: { ...INK_LIGHT_SEMANTIC, ...LIGHT_BINDINGS.indigo },
  sage: { ...INK_LIGHT_SEMANTIC, ...LIGHT_BINDINGS.sage },
  plum: { ...INK_LIGHT_SEMANTIC, ...LIGHT_BINDINGS.plum },
  ochre: { ...INK_LIGHT_SEMANTIC, ...LIGHT_BINDINGS.ochre },
  ivory: { ...INK_LIGHT_SEMANTIC, ...LIGHT_BINDINGS.ivory },
};

/**
 * Dark paper is re-inked for contrast rather than numerically inverted.
 */
export const DARK_THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: { ...INK_DARK_SEMANTIC, ...DARK_BINDINGS.terracotta },
  indigo: { ...INK_DARK_SEMANTIC, ...DARK_BINDINGS.indigo },
  sage: { ...INK_DARK_SEMANTIC, ...DARK_BINDINGS.sage },
  plum: { ...INK_DARK_SEMANTIC, ...DARK_BINDINGS.plum },
  ochre: { ...INK_DARK_SEMANTIC, ...DARK_BINDINGS.ochre },
  ivory: { ...INK_DARK_SEMANTIC, ...DARK_BINDINGS.ivory },
};

export const ACCENTS: Record<ThemeId, string> = {
  terracotta: '#b63226', indigo: '#b63226', sage: '#b63226', plum: '#b63226', ochre: '#b63226', ivory: '#b63226',
};

export const DARK_ACCENTS: Record<ThemeId, string> = {
  terracotta: '#ee7868', indigo: '#ee7868', sage: '#ee7868', plum: '#ee7868', ochre: '#ee7868', ivory: '#ee7868',
};

export const THEME_NAMES: Record<ThemeId, string> = {
  terracotta: '文献纸 · 焦墨',
  indigo: '靛蓝衣 · 楮纸',
  sage: '青檀纸 · 松烟',
  plum: '紫云纸 · 茄绀',
  ochre: '黄麻纸 · 栗壳',
  ivory: '素宣纸 · 纯墨',
};

export const THEME_DESCRIPTIONS: Record<ThemeId, string> = {
  terracotta: '焦茶书衣 · 冷米文献纸',
  indigo: '深靛布衣 · 素雅冷楮纸',
  sage: '松烟墨衣 · 清冷青檀纸',
  plum: '茄绀书衣 · 柔紫灰雁皮纸',
  ochre: '栗壳书衣 · 温润黄麻竹纸',
  ivory: '纯墨书衣 · 高对比素宣纸',
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
  'var(--font-body)';
