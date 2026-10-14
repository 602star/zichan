import type { ThemeId, ThemeMode, ThemeModePreference } from '../theme.js';
import { Settings, type SettingsSection } from './Settings.js';
import { Sync } from './Sync.js';

const TABS: readonly [SettingsSection, string][] = [
  ['ledger', '记账'],
  ['device', '本机备份'],
  ['server', '服务器与同步'],
  ['restore', '恢复数据'],
  ['security', '解锁与安全'],
  ['appearance', '外观'],
];

export function SettingsPage({ theme, mode, resolvedMode, setTheme, setMode, section, onSelectSection, onExportBackup, onImportBackup }: {
  theme: ThemeId;
  mode: ThemeModePreference;
  resolvedMode: ThemeMode;
  setTheme: (theme: ThemeId) => void;
  setMode: (mode: ThemeModePreference) => void;
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  onExportBackup: () => Promise<void>;
  onImportBackup: () => void;
}) {
  const appearance = { theme, mode, resolvedMode, setTheme, setMode };
  const backupActions = { onExportBackup, onImportBackup };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div className="zc-tabs" role="tablist" aria-label="设置分类">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={section === id ? 'zc-tab is-active' : 'zc-tab'}
            onClick={() => onSelectSection(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {section === 'ledger' || section === 'appearance'
        ? <Settings {...appearance} {...backupActions} section={section} />
        : <Sync {...appearance} {...backupActions} section={section} onSelectSection={onSelectSection} />}
    </div>
  );
}
