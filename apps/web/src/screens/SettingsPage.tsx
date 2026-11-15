import type { ThemeId, ThemeMode, ThemeModePreference } from '../theme.js';
import { Settings, type SettingsSection } from './Settings.js';
import { Sync } from './Sync.js';
import { useTabSet } from '../ui/useTabSet.js';
import { useEffect } from 'react';
import { useCompactView } from '../ui/useCompactView.js';
import { TaskList, MobilePageHeader, useMobileSection } from '../ui/MobilePage.js';
import { navigateTo, useScreenTarget } from '../screen-target.js';

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
  const compact = useCompactView();
  const target = useScreenTarget('settings');
  const [view, open, back] = useMobileSection('settings');
  const active = compact && TABS.some(([id]) => id === view) ? view as SettingsSection : section;
  const select = (next: SettingsSection) => { onSelectSection(next); open(next); };
  useEffect(() => {
    if (compact && target?.tab && TABS.some(([id]) => id === target.tab)) open(target.tab);
  }, [compact, target, open]);
  const appearance = { theme, mode, resolvedMode, setTheme, setMode };
  const backupActions = { onExportBackup, onImportBackup };
  const tabs = useTabSet(TABS.map(([id]) => id), active, select, compact ? 'horizontal' : 'vertical');
  if (compact && view === 'index') return <div className="zc-mobile-task-page">
    <TaskList title="日常使用" items={[
      { label: '记账', note: '默认币种、表单与分类', onClick: () => select('ledger') },
      { label: '外观', note: '纸张、明暗与字号', onClick: () => select('appearance') },
    ]} />
    <TaskList title="当前设备" items={[
      { label: '本机备份', note: '恢复点、导出及数据自检', onClick: () => select('device') },
      { label: '服务器与同步', note: '连接、副本就绪与同步状态', onClick: () => select('server') },
      { label: '恢复数据', note: '先演练，再确认合并或替换', onClick: () => select('restore') },
      { label: '解锁与安全', note: '应用锁与本机保护', onClick: () => select('security') },
    ]} />
    <TaskList title="账本资料" items={[
      { label: '资料管理', note: '分类、账户、价格和模板', onClick: () => navigateTo({ screen: 'manage' }) },
      { label: '我的账号', note: '个人资料、邮箱与账号安全', onClick: () => navigateTo({ screen: 'account' }) },
    ]} />
  </div>;
  return (
    <div className="zc-settings-workspace" style={compact ? { display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' } : undefined}>
      {compact && <MobilePageHeader title={TABS.find(([id]) => id === active)?.[1] ?? '设置'} onBack={back} backLabel="返回设置" />}
      {!compact && <div className="zc-tabs zc-workspace-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            {...tabs.tabProps(id)}
            className={active === id ? 'zc-tab is-active' : 'zc-tab'}
          >
            {label}
          </button>
        ))}
      </div>}
      <div {...(!compact ? tabs.panelProps : {})}>
        {active === 'ledger' || active === 'appearance'
          ? <Settings {...appearance} {...backupActions} section={active} />
          : <Sync {...appearance} {...backupActions} section={active} onSelectSection={select} />}
      </div>
    </div>
  );
}
