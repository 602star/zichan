/** Theme tokens copied verbatim from the prototype (THEMES in the .dc.html). */
export type ThemeId = 'terracotta' | 'sage' | 'plum';

export const THEMES: Record<ThemeId, Record<string, string>> = {
  terracotta: {
    '--bg': '#f0e9dc', '--surface': '#fffcf6', '--surface-2': '#f6efe2',
    '--fg': '#2b2620', '--fg-muted': '#6b6155', '--fg-subtle': '#a3988a',
    '--border': '#e6dccb', '--accent': '#bf6b3f', '--accent-soft': '#f6e4d5',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#9a681d',
  },
  sage: {
    '--bg': '#e9eee9', '--surface': '#fbfdfb', '--surface-2': '#eef3ee',
    '--fg': '#25302a', '--fg-muted': '#5c6b62', '--fg-subtle': '#93a397',
    '--border': '#d8e2d9', '--accent': '#4f7d64', '--accent-soft': '#dfeae1',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#8a681d',
  },
  plum: {
    '--bg': '#f1eaee', '--surface': '#fffcfe', '--surface-2': '#f6eef3',
    '--fg': '#2c2429', '--fg-muted': '#6b5d65', '--fg-subtle': '#a1929a',
    '--border': '#e8dbe3', '--accent': '#8f5670', '--accent-soft': '#f2e2ec',
    '--positive': '#3f8f6b', '--negative': '#c2604a', '--warning': '#94621c',
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
