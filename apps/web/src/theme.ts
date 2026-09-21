/**
 * Design tokens. The semantic palette below is copied verbatim from the prototype
 * (THEMES in the .dc.html); the categorical slots are ours and are documented in
 * place.
 *
 * A theme is one accent family (terracotta / sage / plum) and a mode (`light` /
 * `dark`). They are separate axes on purpose: choosing a warm accent should not
 * also force a background, and a reader who wants a dark screen should not lose
 * the accent they picked. `THEMES` holds the light values for every family and
 * `DARK_THEMES` the dark ones, keyed by the same token names so the two can be
 * swapped without any call site knowing which it got.
 */
export type ThemeId = 'terracotta' | 'sage' | 'plum';

/** Whether the palette is light or dark. `system` is a preference, not a palette. */
export type ThemeMode = 'light' | 'dark';

/** What the reader asked for. `system` follows the operating system setting. */
export type ThemeModePreference = ThemeMode | 'system';

/*
 * Categorical colours for composition charts.
 *
 * A category cannot borrow a semantic colour: `--negative` already means 「支出」
 * on these same screens, so a red segment would claim two things at once. The
 * six slots are therefore ordered rather than meaningful - slot 1 follows each
 * theme's accent so the first slice always looks native to the palette, and the
 * remaining hues stay put so a legend is still recognisable when the theme
 * changes. `--cat-other` is the 「其他」 bucket and is the only desaturated slot,
 * because it is a leftover rather than a category.
 *
 * `styles.css` repeats these as `:root` defaults; the theme wins at runtime
 * because it is injected as an inline custom-property set on the app shell.
 */
const CATEGORICAL: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--cat-1': '#bf6b3f', '--cat-2': '#3f7d92', '--cat-3': '#6b8f3f',
    '--cat-4': '#b8862f', '--cat-5': '#a04a72', '--cat-6': '#5b5f9e',
    '--cat-other': '#9c948a',
  },
  sage: {
    '--cat-1': '#4f7d64', '--cat-2': '#33707f', '--cat-3': '#6f8b3a',
    '--cat-4': '#ab8226', '--cat-5': '#9a4a6e', '--cat-6': '#575c99',
    '--cat-other': '#96a094',
  },
  plum: {
    '--cat-1': '#8f5670', '--cat-2': '#4a7086', '--cat-3': '#6d8a41',
    '--cat-4': '#b08033', '--cat-5': '#a3486a', '--cat-6': '#5a5a9e',
    '--cat-other': '#9e929a',
  },
};

/*
 * The same slots for a dark screen. They are not the light hues dimmed by a
 * fixed factor: a mid-tone that reads well on paper turns muddy on a dark
 * surface, so each slot is re-picked to keep the same hue and a lightness that
 * separates it from the background. Slot 1 again follows the accent, so the
 * donut still looks native to the palette it was drawn in.
 */
const DARK_CATEGORICAL: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--cat-1': '#e0a072', '--cat-2': '#7fb6cc', '--cat-3': '#a3c47a',
    '--cat-4': '#d9b46a', '--cat-5': '#cf8fb0', '--cat-6': '#9aa0d8',
    '--cat-other': '#9c948a',
  },
  sage: {
    '--cat-1': '#7fb894', '--cat-2': '#6fb0c0', '--cat-3': '#a8c47a',
    '--cat-4': '#d3b06a', '--cat-5': '#cb8aab', '--cat-6': '#9398d6',
    '--cat-other': '#96a094',
  },
  plum: {
    '--cat-1': '#cf8fae', '--cat-2': '#7fb0c6', '--cat-3': '#a8c47a',
    '--cat-4': '#d3b06a', '--cat-5': '#c9889f', '--cat-6': '#9297d4',
    '--cat-other': '#9e929a',
  },
};

/*
 * Status surfaces and control text.
 *
 * These exist because the management console already referred to them
 * (`var(--surface-muted, #f1f3f4)` and friends) without anything ever declaring
 * them: every one of those references fell through to its hardcoded light
 * fallback, which is why the console could not be themed at all. Naming them
 * here - once per theme and once per mode - is what makes a badge or a disabled
 * control belong to the palette instead of to a literal.
 *
 * `--on-accent` is the text that sits on an accent-filled button. It is white in
 * light mode and near-black in dark mode, because a dark accent is the readable
 * choice on paper while a light accent is the readable choice on a dark screen.
 */
const SURFACES: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--border-strong': '#d3c5ae', '--surface-muted': '#f1ece2',
    '--ok-surface': '#e6f4ea', '--warn-surface': '#fdf3dc', '--danger-surface': '#fce8e6',
  },
  sage: {
    '--border-strong': '#c2d0c4', '--surface-muted': '#e6ece7',
    '--ok-surface': '#e4f1e7', '--warn-surface': '#fbf3da', '--danger-surface': '#fbe7e4',
  },
  plum: {
    '--border-strong': '#d6c3ce', '--surface-muted': '#f2ecf0',
    '--ok-surface': '#e6f4ea', '--warn-surface': '#fdf3dc', '--danger-surface': '#fce8e6',
  },
};

const DARK_SURFACES: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--border-strong': '#4d4239', '--surface-muted': '#2a2420',
    '--ok-surface': '#1e2f26', '--warn-surface': '#332a1a', '--danger-surface': '#38211e',
  },
  sage: {
    '--border-strong': '#3f4c43', '--surface-muted': '#212922',
    '--ok-surface': '#1b2c22', '--warn-surface': '#2f2818', '--danger-surface': '#331e1c',
  },
  plum: {
    '--border-strong': '#493b44', '--surface-muted': '#282023',
    '--ok-surface': '#1d2c24', '--warn-surface': '#302818', '--danger-surface': '#341e1d',
  },
};

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

export const THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--bg': '#f0e9dc', '--surface': '#fffcf6', '--surface-2': '#f6efe2',
    '--fg': '#2b2620', '--fg-muted': '#6b6155', '--fg-subtle': '#a3988a',
    '--border': '#e6dccb', '--accent': '#bf6b3f', '--accent-soft': '#f6e4d5',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#9a681d',
    '--on-accent': '#ffffff', '--danger': '#c2604a', '--text-muted': '#6b6155',
    ...SURFACES.terracotta,
    ...CATEGORICAL.terracotta,
  },
  sage: {
    '--bg': '#e9eee9', '--surface': '#fbfdfb', '--surface-2': '#eef3ee',
    '--fg': '#25302a', '--fg-muted': '#5c6b62', '--fg-subtle': '#93a397',
    '--border': '#d8e2d9', '--accent': '#4f7d64', '--accent-soft': '#dfeae1',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#8a681d',
    '--on-accent': '#ffffff', '--danger': '#c2604a', '--text-muted': '#5c6b62',
    ...SURFACES.sage,
    ...CATEGORICAL.sage,
  },
  plum: {
    '--bg': '#f1eaee', '--surface': '#fffcfe', '--surface-2': '#f6eef3',
    '--fg': '#2c2429', '--fg-muted': '#6b5d65', '--fg-subtle': '#a1929a',
    '--border': '#e8dbe3', '--accent': '#8f5670', '--accent-soft': '#f2e2ec',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#94621c',
    '--on-accent': '#ffffff', '--danger': '#c2604a', '--text-muted': '#6b5d65',
    ...SURFACES.plum,
    ...CATEGORICAL.plum,
  },
};

/**
 * The dark palette for each accent family, with the same token names as `THEMES`.
 *
 * The dark surfaces are warm-neutral rather than pure grey so the accent still
 * looks related to them, and every status colour is re-picked instead of reused:
 * `--negative` at its light value is unreadable on a dark surface, and a
 * re-picked one keeps 「支出」 recognisably red without glowing.
 */
export const DARK_THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--bg': '#191512', '--surface': '#221d19', '--surface-2': '#2b2521',
    '--fg': '#f2e9dd', '--fg-muted': '#b9ab9a', '--fg-subtle': '#8a7e70',
    '--border': '#3b322b', '--accent': '#e0a072', '--accent-soft': '#3a2a1f',
    '--positive': '#6fc79b', '--negative': '#e79079', '--warning': '#d9ad63',
    '--on-accent': '#241a12', '--danger': '#e79079', '--text-muted': '#b9ab9a',
    ...DARK_SURFACES.terracotta,
    ...DARK_CATEGORICAL.terracotta,
  },
  sage: {
    '--bg': '#121814', '--surface': '#1a211c', '--surface-2': '#222a24',
    '--fg': '#e8f0e9', '--fg-muted': '#a8b8ac', '--fg-subtle': '#7d8c81',
    '--border': '#2d3830', '--accent': '#7fb894', '--accent-soft': '#1e2b23',
    '--positive': '#6fc79b', '--negative': '#e79079', '--warning': '#d3ab63',
    '--on-accent': '#0f1a13', '--danger': '#e79079', '--text-muted': '#a8b8ac',
    ...DARK_SURFACES.sage,
    ...DARK_CATEGORICAL.sage,
  },
  plum: {
    '--bg': '#171214', '--surface': '#201a1d', '--surface-2': '#292125',
    '--fg': '#f1e8ec', '--fg-muted': '#bda9b4', '--fg-subtle': '#8e7d88',
    '--border': '#372c33', '--accent': '#cf8fae', '--accent-soft': '#33222c',
    '--positive': '#6fc79b', '--negative': '#e79079', '--warning': '#d3ab63',
    '--on-accent': '#1f1319', '--danger': '#e79079', '--text-muted': '#bda9b4',
    ...DARK_SURFACES.plum,
    ...DARK_CATEGORICAL.plum,
  },
};

export const ACCENTS: Record<ThemeId, string> = {
  terracotta: '#bf6b3f', sage: '#4f7d64', plum: '#8f5670',
};

export const DARK_ACCENTS: Record<ThemeId, string> = {
  terracotta: '#e0a072', sage: '#7fb894', plum: '#cf8fae',
};

export const THEME_NAMES: Record<ThemeId, string> = {
  terracotta: '暖纸 · 赭石', sage: '鼠尾草 · 苔绿', plum: '梅子 · 紫褐',
};

export const THEME_MODE_NAMES: Record<ThemeModePreference, string> = {
  light: '浅色', dark: '深色', system: '跟随系统',
};

/** The palette for one accent family in one mode. */
export function themeTokens(theme: ThemeId, mode: ThemeMode): Record<string, string> {
  return { ...(mode === 'dark' ? DARK_THEMES[theme] : THEMES[theme]), ...SHADOWS[mode] };
}

/** The accent swatch for one accent family in one mode. */
export function themeAccent(theme: ThemeId, mode: ThemeMode): string {
  return mode === 'dark' ? DARK_ACCENTS[theme] : ACCENTS[theme];
}

export const FONT_FAMILY =
  "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif";
