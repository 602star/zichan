/**
 * Design tokens. The semantic palette below is copied verbatim from the prototype
 * (THEMES in the .dc.html); the categorical slots are ours and are documented in
 * place.
 */
export type ThemeId = 'terracotta' | 'sage' | 'plum';

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

/** The ordered categorical slots a composition chart may use. */
export const CATEGORY_COLORS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)'];

/** The bucket that collects every category past the visible slots. */
export const OTHER_CATEGORY_COLOR = 'var(--cat-other)';

export const THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--bg': '#f0e9dc', '--surface': '#fffcf6', '--surface-2': '#f6efe2',
    '--fg': '#2b2620', '--fg-muted': '#6b6155', '--fg-subtle': '#a3988a',
    '--border': '#e6dccb', '--accent': '#bf6b3f', '--accent-soft': '#f6e4d5',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#9a681d',
    ...CATEGORICAL.terracotta,
  },
  sage: {
    '--bg': '#e9eee9', '--surface': '#fbfdfb', '--surface-2': '#eef3ee',
    '--fg': '#25302a', '--fg-muted': '#5c6b62', '--fg-subtle': '#93a397',
    '--border': '#d8e2d9', '--accent': '#4f7d64', '--accent-soft': '#dfeae1',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#8a681d',
    ...CATEGORICAL.sage,
  },
  plum: {
    '--bg': '#f1eaee', '--surface': '#fffcfe', '--surface-2': '#f6eef3',
    '--fg': '#2c2429', '--fg-muted': '#6b5d65', '--fg-subtle': '#a1929a',
    '--border': '#e8dbe3', '--accent': '#8f5670', '--accent-soft': '#f2e2ec',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#94621c',
    ...CATEGORICAL.plum,
  },
};

export const ACCENTS: Record<ThemeId, string> = {
  terracotta: '#bf6b3f', sage: '#4f7d64', plum: '#8f5670',
};

export const THEME_NAMES: Record<ThemeId, string> = {
  terracotta: '暖纸 · 赭石', sage: '鼠尾草 · 苔绿', plum: '梅子 · 紫褐',
};

export const FONT_FAMILY =
  "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif";
