import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { requestJson } from '@zichan/db';
import { accountProtection } from '../account-protection.js';
import { authenticateSyncProfile } from '../sync-auth.js';
import { buildSyncBaseUrl, loadSyncConnections } from '../sync-config.js';
import { CardAlert } from './Card.js';

type PushFormat = 'bark' | 'feishu' | 'dingtalk' | 'wecom' | 'discord' | 'slack' | 'generic' | 'text';
type NotificationKind = 'daily' | 'weekly' | 'monthly' | 'inactivity' | 'bill_due' | 'dca' | 'calendar' | 'budget_alert' | 'fixed_asset';

interface PushChannelDraft {
  kind: 'webhook';
  name: string;
  url: string;
  format: PushFormat;
  deviceKey?: string;
  group?: string;
  enabled: boolean;
}

interface NotificationPreferences {
  timezone: string;
  privacyMode: boolean;
  emailEnabled: boolean;
  daily: { enabled: boolean; hour: number; skipIfEmpty: boolean };
  weekly: { enabled: boolean; dayOfWeek: number; hour: number };
  monthly: { enabled: boolean; mode: 'calendar' | 'payday' | 'payday_auto'; paydayDay: number; hour: number };
  inactivity: { enabled: boolean; days: number; cooldownDays: number; hour: number };
  billDue: { enabled: boolean; daysBefore: number; hour: number };
  dca: { enabled: boolean; daysBefore: number; hour: number };
  calendar: { enabled: boolean; daysBefore: number; hour: number };
  budgetAlert: { enabled: boolean; warnPercent: number };
  fixedAsset: { enabled: boolean; daysBefore: number; hour: number };
  pushChannels: PushChannelDraft[];
}

interface ChannelDeliveryResult {
  name: string;
  kind: 'email' | 'webhook';
  state: 'sent' | 'failed' | 'skipped';
  error?: string;
}

interface DeliveryRecord {
  id: string;
  kind: string;
  periodKey: string;
  status: string;
  channels: ChannelDeliveryResult[];
  summary: string;
  createdAt: string;
}

interface NotificationState {
  preferences: NotificationPreferences;
  emailAvailable: boolean;
  emailVerified: boolean;
  email: string | null;
  custodyManaged: boolean;
  recentDeliveries: DeliveryRecord[];
}

const FORMAT_LABELS: Record<PushFormat, string> = {
  bark: 'Bark（iOS 推送）',
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
  wecom: '企业微信机器人',
  discord: 'Discord Webhook',
  slack: 'Slack Webhook',
  generic: '通用 JSON Webhook',
  text: '纯文本 Webhook',
};

const KIND_LABELS: Record<NotificationKind, string> = {
  monthly: '月报',
  weekly: '周报',
  daily: '日报',
  inactivity: '未记账提醒',
  bill_due: '账单还款提醒',
  dca: '定投计划提醒',
  calendar: '生日与纪念日提醒',
  budget_alert: '预算超支预警',
  fixed_asset: '物品耗材与质保提醒',
};

const WEEKDAY_LABELS = [
  [1, '周一'],
  [2, '周二'],
  [3, '周三'],
  [4, '周四'],
  [5, '周五'],
  [6, '周六'],
  [7, '周日'],
] as const;

const COMMON_TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function paydayDescription(day: number): string {
  if (day === 1) return '每月 1 日发薪：统计上月 1 日至月末（等同自然月），发薪日当天发送。';
  return `每月 ${day} 日发薪：统计上月 ${day} 日至本月 ${day - 1} 日（遇到小月自动对齐月末），每月 ${day} 日发送。`;
}

function ToggleRow({
  title,
  description,
  badge,
  badgeOk,
  checked,
  disabled,
  onChange,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  badgeOk?: boolean;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="zc-notif-row">
      <div className="zc-notif-row-main">
        <div className="zc-notif-row-copy">
          <div className="zc-notif-row-title">
            <span>{title}</span>
            {badge && <span className={`zc-notif-badge${badgeOk ? ' is-ok' : ''}`}>{badge}</span>}
          </div>
          <p className="zc-notif-row-desc">{description}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={title}
          className="zc-notif-switch"
          disabled={disabled}
          onClick={() => onChange(!checked)}
        />
      </div>
      {checked && children && <div className="zc-notif-controls">{children}</div>}
    </div>
  );
}

function HourSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (hour: number) => void;
}) {
  return (
    <label className="zc-notif-field">
      <span>{label}</span>
      <select className="zc-input" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
      </select>
    </label>
  );
}

export function AccountNotificationsPanel() {
  const profileId = accountProtection()?.profileId;
  const profile = loadSyncConnections().find((row) => row.id === profileId);
  const [state, setState] = useState<NotificationState>();
  const [prefs, setPrefs] = useState<NotificationPreferences>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<{ subject: string; html: string }>();
  const [testKind, setTestKind] = useState<NotificationKind>('monthly');
  const [testResults, setTestResults] = useState<{ subject: string; status: string; results: ChannelDeliveryResult[] }>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // New push channel form state
  const [addingChannel, setAddingChannel] = useState(false);
  const [chName, setChName] = useState('');
  const [chFormat, setChFormat] = useState<PushFormat>('bark');
  const [chUrl, setChUrl] = useState('https://api.day.app/push');
  const [chDeviceKey, setChDeviceKey] = useState('');
  const [chGroup, setChGroup] = useState('有本');

  const api = useCallback(async <T,>(path = '', method = 'GET', body?: object): Promise<T> => {
    const selected = loadSyncConnections().find((row) => row.id === profileId);
    if (!selected) throw new Error('当前没有服务器账号');
    const token = await authenticateSyncProfile(selected);
    const response = await requestJson(`${buildSyncBaseUrl(selected)}/api/auth/notifications${path}`, {
      method,
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error || `通知设置请求失败（HTTP ${response.status}）`);
    return result;
  }, [profileId]);

  const refresh = useCallback(async () => {
    const next = await api<NotificationState>();
    setState(next);
    setPrefs(next.preferences);
  }, [api]);

  useEffect(() => {
    if (!profileId) return;
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [profileId, refresh]);

  if (!profile) return null;

  async function save(nextPrefs: NotificationPreferences) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await api<Omit<NotificationState, 'recentDeliveries'>>('', 'PUT', nextPrefs);
      setState((prev) => ({
        ...updated,
        recentDeliveries: prev?.recentDeliveries ?? [],
      }));
      setPrefs(updated.preferences);
      setNotice('报告与提醒设置已保存。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (previewing || !prefs) return;
    setPreviewing(true);
    setError('');
    try {
      await api('', 'PUT', prefs);
      const res = await api<{ subject: string; html: string }>('/preview', 'POST', { kind: testKind });
      setPreviewHtml(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function runTest() {
    if (testing || !prefs) return;
    setTesting(true);
    setError('');
    setNotice('');
    try {
      await api('', 'PUT', prefs);
      const res = await api<{ subject: string; summary: string; status: string; results: ChannelDeliveryResult[] }>('/test', 'POST', { kind: testKind });
      setTestResults(res);
      setNotice(`测试发送完成（状态：${res.status}）。`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  function handleAddChannel() {
    if (!prefs) return;
    const name = chName.trim();
    const url = chUrl.trim();
    if (!name || !url) {
      setError('请填写渠道名称和推送地址。');
      return;
    }
    if (chFormat === 'bark' && !chDeviceKey.trim()) {
      setError('Bark 推送需要填写设备密钥（Device Key）。');
      return;
    }
    const nextChannel: PushChannelDraft = {
      kind: 'webhook',
      name,
      url,
      format: chFormat,
      ...(chFormat === 'bark' ? { deviceKey: chDeviceKey.trim(), ...(chGroup.trim() ? { group: chGroup.trim() } : {}) } : {}),
      enabled: true,
    };
    setPrefs({ ...prefs, pushChannels: [...prefs.pushChannels, nextChannel] });
    setChName('');
    setChDeviceKey('');
    setAddingChannel(false);
    setError('');
  }

  const browserTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'; }
    catch { return 'Asia/Shanghai'; }
  })();
  const timezoneChoices = Array.from(new Set([browserTz, ...(prefs ? [prefs.timezone] : []), ...COMMON_TIMEZONES]));

  return (
    <section className="zc-card zc-notif-panel" aria-label="报告与提醒">
      <div className="zc-section-head">
        <div>
          <h2 className="zc-section-title">报告与提醒</h2>
          <p className="zc-caption">服务端仅在内存中临时解密统计托管账本（明文不落盘），通过 HTML 邮件或推送渠道按时送达。</p>
        </div>
      </div>

      {state && !state.custodyManaged && (
        <CardAlert tone="warning" role="status">
          当前账本未处于服务器托管模式，后台无法自动生成报告与提醒。如需启用，请在「数据保护」中开启托管模式。
        </CardAlert>
      )}
      {error && <CardAlert tone="danger" role="alert">{error}</CardAlert>}

      {!prefs ? (
        <p className="zc-caption">正在读取报告与提醒设置…</p>
      ) : (
        <>
          {/* 1. 投递与通用 */}
          <div className="zc-notif-group">
            <div className="zc-notif-group-head">
              <h3>投递与通用</h3>
            </div>
            <div className="zc-notif-list">
              <div className="zc-notif-row">
                <div className="zc-notif-row-main">
                  <div className="zc-notif-row-copy">
                    <div className="zc-notif-row-title">统计时区</div>
                    <p className="zc-notif-row-desc">所有报告周期与提醒发送时段均按此时区计算。</p>
                  </div>
                  <select
                    className="zc-input"
                    aria-label="统计时区"
                    style={{ width: 'auto', minWidth: 168 }}
                    value={prefs.timezone}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })}
                  >
                    {timezoneChoices.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </div>
              </div>

              <ToggleRow
                title="HTML 邮件投递"
                badge={state?.emailVerified ? `已验证 · ${state.email}` : state?.emailAvailable === false ? '服务器未配置 SMTP' : '需先验证邮箱'}
                badgeOk={Boolean(state?.emailVerified && state?.emailAvailable)}
                description={state && !state.emailAvailable
                  ? '服务器尚未配置 SMTP 发信渠道；仍可使用下方 Bark / Webhook 推送接收报告与提醒。'
                  : '发送排版精简的 HTML 邮件（含纯文本回退），需在「邮箱」页完成邮箱验证。'}
                checked={prefs.emailEnabled}
                disabled={busy}
                onChange={(checked) => setPrefs({ ...prefs, emailEnabled: checked })}
              />

              <ToggleRow
                title="隐私脱敏模式"
                description="开启后，邮件与推送中的具体金额显示为 ****，仅保留笔数、活跃天数与环比百分比。"
                checked={prefs.privacyMode}
                disabled={busy}
                onChange={(checked) => setPrefs({ ...prefs, privacyMode: checked })}
              />
            </div>
          </div>

          {/* 2. 周期统计报告 */}
          <div className="zc-notif-group">
            <div className="zc-notif-group-head">
              <h3>周期统计报告</h3>
            </div>
            <div className="zc-notif-list">
              <ToggleRow
                title="每日统计（日报）"
                description="汇总当日收支、分类支出与大额消费；发送时段早于 12:00 时统计前一日。"
                checked={prefs.daily.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, daily: { ...prefs.daily, enabled } })}
              >
                <HourSelect
                  label="发送时段"
                  value={prefs.daily.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, daily: { ...prefs.daily, hour } })}
                />
                <label className="zc-notif-field">
                  <input
                    type="checkbox"
                    checked={prefs.daily.skipIfEmpty}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, daily: { ...prefs.daily, skipIfEmpty: e.target.checked } })}
                  />
                  <span>当日无交易时不发送</span>
                </label>
              </ToggleRow>

              <ToggleRow
                title="每周统计（周报）"
                description="总结上一完整自然周（周一至周日）的收支结余、环比变化与分类排行。"
                checked={prefs.weekly.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, weekly: { ...prefs.weekly, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>发送日</span>
                  <select
                    className="zc-input"
                    value={prefs.weekly.dayOfWeek}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, weekly: { ...prefs.weekly, dayOfWeek: Number(e.target.value) } })}
                  >
                    {WEEKDAY_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <HourSelect
                  label="发送时段"
                  value={prefs.weekly.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, weekly: { ...prefs.weekly, hour } })}
                />
              </ToggleRow>

              <ToggleRow
                title="每月统计（月报）"
                badge={prefs.monthly.enabled ? (prefs.monthly.mode === 'payday_auto' ? '智能发薪月' : prefs.monthly.mode === 'payday' ? `每月 ${prefs.monthly.paydayDay} 日` : '自然月') : undefined}
                badgeOk={prefs.monthly.enabled}
                description="支持按工资/薪资收入自动切分发薪周期，或按固定发薪日、自然月统计。"
                checked={prefs.monthly.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, monthly: { ...prefs.monthly, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>统计口径</span>
                  <select
                    className="zc-input"
                    value={prefs.monthly.mode}
                    disabled={busy}
                    onChange={(e) => {
                      const value = e.target.value;
                      const mode = value === 'payday_auto' ? 'payday_auto' : value === 'payday' ? 'payday' : 'calendar';
                      setPrefs({ ...prefs, monthly: { ...prefs.monthly, mode } });
                    }}
                  >
                    <option value="payday_auto">智能发薪月（自动识别工资/薪资收入）</option>
                    <option value="payday">固定发薪日（自定义每月几号）</option>
                    <option value="calendar">自然月（每月 1 日至月末）</option>
                  </select>
                </label>
                {prefs.monthly.mode === 'payday' && (
                  <label className="zc-notif-field">
                    <span>发薪日</span>
                    <select
                      className="zc-input"
                      value={prefs.monthly.paydayDay}
                      disabled={busy}
                      onChange={(e) => setPrefs({ ...prefs, monthly: { ...prefs.monthly, paydayDay: Number(e.target.value) } })}
                    >
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>每月 {d} 日</option>)}
                    </select>
                  </label>
                )}
                <HourSelect
                  label="发送时段"
                  value={prefs.monthly.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, monthly: { ...prefs.monthly, hour } })}
                />
                <p className="zc-notif-field-note">
                  {prefs.monthly.mode === 'payday_auto'
                    ? '自动以「上次工资/薪资收入日期」至「本次薪资收入前一日」为一个周期；记入新一笔薪资后自动发送上期月报（15 天内的拆分薪资合并为同一期）。'
                    : prefs.monthly.mode === 'payday'
                      ? paydayDescription(prefs.monthly.paydayDay)
                      : '每月 1 日统计并发送上个自然月的收支与分类汇总。'}
                </p>
              </ToggleRow>
            </div>
          </div>

          {/* 3. 账本提醒 */}
          <div className="zc-notif-group">
            <div className="zc-notif-group-head">
              <h3>账本提醒</h3>
            </div>
            <div className="zc-notif-list">
              <ToggleRow
                title="未记账提醒"
                description="当连续多日未新增流水时发出提醒，并按冷却间隔避免每日重复打扰。"
                checked={prefs.inactivity.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, inactivity: { ...prefs.inactivity, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>连续未记账</span>
                  <input
                    className="zc-input"
                    type="number"
                    min={1}
                    max={60}
                    style={{ width: 68 }}
                    value={prefs.inactivity.days}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, inactivity: { ...prefs.inactivity, days: Math.max(1, Math.min(60, Number(e.target.value) || 3)) } })}
                  />
                  <span>天</span>
                </label>
                <label className="zc-notif-field">
                  <span>冷却间隔</span>
                  <input
                    className="zc-input"
                    type="number"
                    min={1}
                    max={30}
                    style={{ width: 68 }}
                    value={prefs.inactivity.cooldownDays}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, inactivity: { ...prefs.inactivity, cooldownDays: Math.max(1, Math.min(30, Number(e.target.value) || 3)) } })}
                  />
                  <span>天</span>
                </label>
                <HourSelect
                  label="提醒时段"
                  value={prefs.inactivity.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, inactivity: { ...prefs.inactivity, hour } })}
                />
              </ToggleRow>

              <ToggleRow
                title="账单还款到期提醒"
                description="在信用卡或贷款账户的还款日到来前提前提醒，避免逾期。"
                checked={prefs.billDue.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, billDue: { ...prefs.billDue, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>提前</span>
                  <input
                    className="zc-input"
                    type="number"
                    min={0}
                    max={14}
                    style={{ width: 68 }}
                    value={prefs.billDue.daysBefore}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, billDue: { ...prefs.billDue, daysBefore: Math.max(0, Math.min(14, Number(e.target.value) || 0)) } })}
                  />
                  <span>天提醒</span>
                </label>
                <HourSelect
                  label="提醒时段"
                  value={prefs.billDue.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, billDue: { ...prefs.billDue, hour } })}
                />
              </ToggleRow>

              <ToggleRow
                title="定投计划提醒"
                description="当有待执行或即将到期的自动定投计划时发出提醒。"
                checked={prefs.dca.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, dca: { ...prefs.dca, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>提前</span>
                  <input
                    className="zc-input"
                    type="number"
                    min={0}
                    max={14}
                    style={{ width: 68 }}
                    value={prefs.dca.daysBefore}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, dca: { ...prefs.dca, daysBefore: Math.max(0, Math.min(14, Number(e.target.value) || 0)) } })}
                  />
                  <span>天提醒</span>
                </label>
                <HourSelect
                  label="提醒时段"
                  value={prefs.dca.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, dca: { ...prefs.dca, hour } })}
                />
              </ToggleRow>

              <ToggleRow
                title="日历生日与纪念日提醒"
                description="结合首页日历中的阳历与农历生日、纪念日，提前 1~3 天发送提醒。"
                checked={prefs.calendar.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, calendar: { ...prefs.calendar, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>提前</span>
                  <input
                    className="zc-input"
                    type="number"
                    min={0}
                    max={14}
                    style={{ width: 68 }}
                    value={prefs.calendar.daysBefore}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, calendar: { ...prefs.calendar, daysBefore: Math.max(0, Math.min(14, Number(e.target.value) || 0)) } })}
                  />
                  <span>天提醒</span>
                </label>
                <HourSelect
                  label="提醒时段"
                  value={prefs.calendar.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, calendar: { ...prefs.calendar, hour } })}
                />
              </ToggleRow>

              <ToggleRow
                title="预算超支预警"
                description="当某分类本月支出达到预警线或 100% 超支时即时推送提醒，同一档位当月只提醒一次。"
                checked={prefs.budgetAlert.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, budgetAlert: { ...prefs.budgetAlert, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>预警比例</span>
                  <input
                    className="zc-input"
                    type="number"
                    min={50}
                    max={99}
                    style={{ width: 68 }}
                    value={prefs.budgetAlert.warnPercent}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, budgetAlert: { ...prefs.budgetAlert, warnPercent: Math.max(50, Math.min(99, Number(e.target.value) || 80)) } })}
                  />
                  <span>%（达到 100% 时再次提醒超支）</span>
                </label>
              </ToggleRow>

              <ToggleRow
                title="物品耗材与质保到期提醒"
                description="检查物品资产的质保、维保、退货/价保截止日期以及耗材低余量，提前发出提醒。"
                checked={prefs.fixedAsset.enabled}
                disabled={busy}
                onChange={(enabled) => setPrefs({ ...prefs, fixedAsset: { ...prefs.fixedAsset, enabled } })}
              >
                <label className="zc-notif-field">
                  <span>提前</span>
                  <input
                    className="zc-input"
                    type="number"
                    min={0}
                    max={60}
                    style={{ width: 68 }}
                    value={prefs.fixedAsset.daysBefore}
                    disabled={busy}
                    onChange={(e) => setPrefs({ ...prefs, fixedAsset: { ...prefs.fixedAsset, daysBefore: Math.max(0, Math.min(60, Number(e.target.value) || 0)) } })}
                  />
                  <span>天提醒</span>
                </label>
                <HourSelect
                  label="提醒时段"
                  value={prefs.fixedAsset.hour}
                  disabled={busy}
                  onChange={(hour) => setPrefs({ ...prefs, fixedAsset: { ...prefs.fixedAsset, hour } })}
                />
              </ToggleRow>
            </div>
          </div>

          {/* 4. 其他推送渠道 */}
          <div className="zc-notif-group">
            <div className="zc-notif-group-head">
              <h3>其他推送渠道</h3>
              {prefs.pushChannels.length < 5 && !addingChannel && (
                <button type="button" className="zc-btn" disabled={busy} onClick={() => setAddingChannel(true)}>添加渠道</button>
              )}
            </div>
            <p className="zc-caption" style={{ margin: '0 0 10px' }}>可同时推送到 Bark、飞书、钉钉、企业微信、Discord、Slack 或自定义 Webhook（最多 5 个）。</p>

            {prefs.pushChannels.length > 0 && (
              <div className="zc-notif-list">
                {prefs.pushChannels.map((ch, idx) => (
                  <div key={ch.name} className="zc-notif-row">
                    <div className="zc-notif-row-main">
                      <div className="zc-notif-row-copy">
                        <div className="zc-notif-row-title">
                          <span>{ch.name}</span>
                          <span className="zc-notif-badge">{FORMAT_LABELS[ch.format]}</span>
                        </div>
                        <p className="zc-notif-row-desc" style={{ overflowWrap: 'anywhere' }}>{ch.url}</p>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={ch.enabled}
                          aria-label={`启用 ${ch.name}`}
                          className="zc-notif-switch"
                          disabled={busy}
                          onClick={() => {
                            const next = [...prefs.pushChannels];
                            next[idx] = { ...ch, enabled: !ch.enabled };
                            setPrefs({ ...prefs, pushChannels: next });
                          }}
                        />
                        <button
                          type="button"
                          className="zc-btn"
                          disabled={busy}
                          onClick={() => setPrefs({ ...prefs, pushChannels: prefs.pushChannels.filter((_, i) => i !== idx) })}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {addingChannel && (
              <div className="zc-notif-channel-form">
                <div className="zc-notif-channel-grid">
                  <label style={{ display: 'grid', gap: 4 }}>
                    <span className="zc-caption">渠道名称</span>
                    <input className="zc-input" value={chName} onChange={(e) => setChName(e.target.value)} placeholder="如：我的手机 Bark" />
                  </label>
                  <label style={{ display: 'grid', gap: 4 }}>
                    <span className="zc-caption">推送格式</span>
                    <select
                      className="zc-input"
                      value={chFormat}
                      onChange={(e) => {
                        const fmt = e.target.value as PushFormat;
                        setChFormat(fmt);
                        if (fmt === 'bark' && !chUrl) setChUrl('https://api.day.app/push');
                      }}
                    >
                      {(Object.keys(FORMAT_LABELS) as PushFormat[]).map((key) => (
                        <option key={key} value={key}>{FORMAT_LABELS[key]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span className="zc-caption">推送地址（URL）</span>
                  <input
                    className="zc-input"
                    value={chUrl}
                    onChange={(e) => setChUrl(e.target.value)}
                    placeholder={chFormat === 'bark' ? 'https://api.day.app/push' : 'https://...'}
                  />
                </label>
                {chFormat === 'bark' && (
                  <div className="zc-notif-channel-grid">
                    <label style={{ display: 'grid', gap: 4 }}>
                      <span className="zc-caption">Bark Device Key</span>
                      <input className="zc-input" type="password" value={chDeviceKey} onChange={(e) => setChDeviceKey(e.target.value)} placeholder="设备密钥（保存后脱敏）" />
                    </label>
                    <label style={{ display: 'grid', gap: 4 }}>
                      <span className="zc-caption">分组（可选）</span>
                      <input className="zc-input" value={chGroup} onChange={(e) => setChGroup(e.target.value)} placeholder="有本" />
                    </label>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="zc-btn zc-btn--primary" onClick={handleAddChannel}>确认添加</button>
                  <button type="button" className="zc-btn" onClick={() => setAddingChannel(false)}>取消</button>
                </div>
              </div>
            )}
          </div>

          {/* 5. 操作与测试 */}
          <div className="zc-notif-actions">
            <button type="button" className="zc-btn zc-btn--primary" disabled={busy} onClick={() => void save(prefs)}>
              {busy ? '保存中…' : '保存设置'}
            </button>
            <div className="zc-notif-test-bar">
              <select
                className="zc-input"
                aria-label="预览或测试类型"
                value={testKind}
                disabled={testing || previewing}
                onChange={(e) => setTestKind(e.target.value as NotificationKind)}
              >
                {(Object.keys(KIND_LABELS) as NotificationKind[]).map((key) => (
                  <option key={key} value={key}>{KIND_LABELS[key]}</option>
                ))}
              </select>
              <button type="button" className="zc-btn" disabled={previewing || busy || !state?.custodyManaged} onClick={() => void runPreview()}>
                {previewing ? '生成中…' : '预览邮件'}
              </button>
              <button type="button" className="zc-btn" disabled={testing || busy || !state?.custodyManaged} onClick={() => void runTest()}>
                {testing ? '发送中…' : '测试发送'}
              </button>
            </div>
          </div>

          {notice && <p role="status" className="zc-caption" style={{ marginTop: 12, color: 'var(--fg)' }}>{notice}</p>}

          {previewHtml && (
            <div className="zc-notif-preview">
              <div className="zc-notif-preview-head">
                <strong>邮件预览：{previewHtml.subject}</strong>
                <button type="button" className="zc-btn" onClick={() => setPreviewHtml(undefined)}>关闭</button>
              </div>
              <iframe title="HTML 邮件预览" sandbox="" srcDoc={previewHtml.html} />
            </div>
          )}

          {testResults && (
            <div className="zc-notif-group">
              <div className="zc-notif-group-head">
                <h3>最近测试结果</h3>
              </div>
              <p className="zc-caption" style={{ margin: '0 0 8px' }}>{testResults.subject}</p>
              <div className="zc-notif-list">
                {testResults.results.length === 0 ? (
                  <div className="zc-notif-delivery-row">
                    <span>未配置可用投递渠道（请验证邮箱或启用至少一个推送渠道）。</span>
                  </div>
                ) : (
                  testResults.results.map((r, idx) => (
                    <div key={`${r.name}-${idx}`} className="zc-notif-delivery-row">
                      <span>{r.name}（{r.kind === 'email' ? '邮件' : '推送'}）</span>
                      <span><strong>{r.state}</strong>{r.error ? ` · ${r.error}` : ''}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {state && state.recentDeliveries.length > 0 && (
            <div className="zc-notif-group">
              <div className="zc-notif-group-head">
                <h3>最近发送记录</h3>
              </div>
              <div className="zc-notif-list">
                {state.recentDeliveries.slice(0, 8).map((row) => (
                  <div key={row.id} className="zc-notif-delivery-row">
                    <span>{row.summary}</span>
                    <span>{row.status} · {row.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
