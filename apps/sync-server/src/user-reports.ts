/**
 * User-level periodic reports (daily / weekly / monthly with calendar or payday cycle),
 * inactivity reminders (N days without recording), HTML email rendering, and multi-channel
 * push delivery (Email + Bark / Feishu / DingTalk / WeCom / Discord / Slack / Webhook).
 */
import { EMAIL_THEME, renderLedgerEmailShell } from './email-theme.js';
import {
  addDays,
  buildLedgerReportDigest,
  dailyReportPeriods,
  daysBetween,
  evaluateBillDueReminders,
  evaluateBudgetAlerts,
  evaluateCalendarReminders,
  evaluateDcaReminders,
  evaluateFixedAssetReminders,
  evaluateInactivityReminder,
  isMonthlyReportDueDay,
  monthlyReportPeriods,
  smartPaydayReportPeriods,
  weeklyReportPeriods,
  zonedCalendarNow,
  type Account,
  type Asset,
  type BillDueReminderStatus,
  type BudgetAlertStatus,
  type CalendarReminderStatus,
  type DcaExecution,
  type DcaPlan,
  type DcaReminderStatus,
  type FixedAsset,
  type FixedAssetConsumable,
  type FixedAssetReminderStatus,
  type FixedAssetUsageLog,
  type FixedAssetUsageMetric,
  type InactivityReminderStatus,
  type LedgerReportDigest,
  type MonthlyPeriodMode,
  type ReportCurrencySummary,
  type Setting,
} from '@zichan/core';
import type { LedgerBackup } from '@zichan/db';
import {
  SECRET_PLACEHOLDER,
  WEBHOOK_FORMATS,
  type ChannelResult,
  type WebhookChannel,
  type WebhookFormat,
} from './alert-channels.js';
import { buildLedgerBackup, type LedgerPreviewOptions } from './ledger-preview.js';
import type { SyncServerStore } from './store.js';

export type UserNotificationKind =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'inactivity'
  | 'bill_due'
  | 'dca'
  | 'calendar'
  | 'budget_alert'
  | 'fixed_asset';

export const USER_NOTIFICATION_KINDS: readonly UserNotificationKind[] = [
  'daily',
  'weekly',
  'monthly',
  'inactivity',
  'bill_due',
  'dca',
  'calendar',
  'budget_alert',
  'fixed_asset',
];

export interface UserNotificationPreferences {
  timezone: string;
  privacyMode: boolean;
  emailEnabled: boolean;
  daily: {
    enabled: boolean;
    hour: number;
    skipIfEmpty: boolean;
    channels?: string[];
  };
  weekly: {
    enabled: boolean;
    /** ISO weekday: 1 = Monday .. 7 = Sunday. */
    dayOfWeek: number;
    hour: number;
    channels?: string[];
  };
  monthly: {
    enabled: boolean;
    mode: MonthlyPeriodMode;
    /** 1..31, used when `mode === 'payday'`. */
    paydayDay: number;
    hour: number;
    channels?: string[];
  };
  inactivity: {
    enabled: boolean;
    days: number;
    cooldownDays: number;
    hour: number;
    channels?: string[];
  };
  billDue: {
    enabled: boolean;
    daysBefore: number;
    hour: number;
    channels?: string[];
  };
  dca: {
    enabled: boolean;
    daysBefore: number;
    hour: number;
    channels?: string[];
  };
  calendar: {
    enabled: boolean;
    daysBefore: number;
    hour: number;
    channels?: string[];
  };
  budgetAlert: {
    enabled: boolean;
    warnPercent: number;
    channels?: string[];
  };
  fixedAsset: {
    enabled: boolean;
    daysBefore: number;
    hour: number;
    channels?: string[];
  };
  pushChannels: WebhookChannel[];
}

export interface UserNotificationDeliveryRecord {
  id: string;
  eventKey: string;
  kind: UserNotificationKind | 'test';
  periodKey: string;
  status: 'sent' | 'partial' | 'failed' | 'skipped';
  channels: ChannelResult[];
  summary: string;
  createdAt: string;
}

const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9._\-\u4e00-\u9fa5 ]{1,40}$/;

export function defaultUserNotificationPreferences(): UserNotificationPreferences {
  return {
    timezone: 'Asia/Shanghai',
    privacyMode: false,
    emailEnabled: true,
    daily: { enabled: false, hour: 21, skipIfEmpty: true },
    weekly: { enabled: false, dayOfWeek: 1, hour: 9 },
    monthly: { enabled: false, mode: 'payday_auto', paydayDay: 10, hour: 9 },
    inactivity: { enabled: false, days: 3, cooldownDays: 3, hour: 20 },
    billDue: { enabled: false, daysBefore: 3, hour: 9 },
    dca: { enabled: false, daysBefore: 1, hour: 9 },
    calendar: { enabled: false, daysBefore: 3, hour: 9 },
    budgetAlert: { enabled: false, warnPercent: 80 },
    fixedAsset: { enabled: false, daysBefore: 7, hour: 9 },
    pushChannels: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertValidTimezone(value: string): string {
  const tz = value.trim() || 'Asia/Shanghai';
  if (tz.length > 64) throw new Error('时区名称过长');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch {
    throw new Error(`无效的时区：${tz}`);
  }
  return tz;
}

function parseInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return num;
}

function parsePushChannels(raw: unknown): WebhookChannel[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('推送渠道必须是一个数组');
  if (raw.length > 5) throw new Error('推送渠道最多配置 5 个');
  const seen = new Set<string>();
  const result: WebhookChannel[] = [];
  raw.forEach((entry, index) => {
    const row = asRecord(entry);
    if (!row) throw new Error(`第 ${index + 1} 个推送渠道格式无效`);
    const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
    if (!CHANNEL_NAME_PATTERN.test(name)) {
      throw new Error(`第 ${index + 1} 个推送渠道名称无效（1-40 字符）`);
    }
    if (seen.has(name)) throw new Error(`推送渠道名称重复：${name}`);
    seen.add(name);
    const url = typeof row['url'] === 'string' ? row['url'].trim() : '';
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 500) {
      throw new Error(`推送渠道 ${name} 的地址必须是有效的 http(s) 地址`);
    }
    const format = (typeof row['format'] === 'string' && row['format'].trim() ? row['format'].trim() : 'generic') as WebhookFormat;
    if (!WEBHOOK_FORMATS.includes(format)) {
      throw new Error(`推送渠道 ${name} 的格式无效（可选：${WEBHOOK_FORMATS.join('、')}）`);
    }
    const enabled = row['enabled'] === undefined ? true : row['enabled'] === true;
    if (format === 'bark') {
      let endpoint: URL;
      try { endpoint = new URL(url); } catch { throw new Error(`推送渠道 ${name} 的 Bark 地址无效`); }
      if (!endpoint.pathname.endsWith('/push') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error(`推送渠道 ${name} 的 Bark 地址应以 /push 结尾，设备密钥请单独填写`);
      }
      const deviceKey = typeof row['deviceKey'] === 'string' ? row['deviceKey'].trim() : '';
      if (!deviceKey || deviceKey.length > 256 || /\s/.test(deviceKey)) {
        throw new Error(`推送渠道 ${name} 缺少有效的 Bark 设备密钥`);
      }
      const group = typeof row['group'] === 'string' ? row['group'].trim() : '';
      if (group.length > 80) throw new Error(`推送渠道 ${name} 的 Bark 分组过长`);
      result.push({ kind: 'webhook', name, url, format, deviceKey, ...(group ? { group } : {}), enabled });
      return;
    }
    result.push({ kind: 'webhook', name, url, format, enabled });
  });
  return result;
}

function parseRuleChannels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = Array.from(new Set(
    raw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item === 'email' || (item.startsWith('webhook:') && item.length > 'webhook:'.length && item.length <= 48)),
  ));
  return cleaned;
}

function ruleChannelsForKind(prefs: UserNotificationPreferences, kind: UserNotificationKind | undefined): string[] | undefined {
  if (!kind) return undefined;
  switch (kind) {
    case 'daily': return prefs.daily.channels;
    case 'weekly': return prefs.weekly.channels;
    case 'monthly': return prefs.monthly.channels;
    case 'inactivity': return prefs.inactivity.channels;
    case 'bill_due': return prefs.billDue.channels;
    case 'dca': return prefs.dca.channels;
    case 'calendar': return prefs.calendar.channels;
    case 'budget_alert': return prefs.budgetAlert.channels;
    case 'fixed_asset': return prefs.fixedAsset.channels;
  }
}

export function parseUserNotificationPreferences(raw: unknown): UserNotificationPreferences {
  const defaults = defaultUserNotificationPreferences();
  const obj = asRecord(raw);
  if (!obj) return defaults;
  const daily = asRecord(obj['daily']) ?? {};
  const weekly = asRecord(obj['weekly']) ?? {};
  const monthly = asRecord(obj['monthly']) ?? {};
  const inactivity = asRecord(obj['inactivity']) ?? {};
  const billDue = asRecord(obj['billDue']) ?? {};
  const dca = asRecord(obj['dca']) ?? {};
  const calendar = asRecord(obj['calendar']) ?? {};
  const budgetAlert = asRecord(obj['budgetAlert']) ?? {};
  const fixedAsset = asRecord(obj['fixedAsset']) ?? {};

  const monthlyMode: MonthlyPeriodMode = monthly['mode'] === 'payday_auto'
    ? 'payday_auto'
    : monthly['mode'] === 'payday'
      ? 'payday'
      : 'calendar';

  return {
    timezone: assertValidTimezone(typeof obj['timezone'] === 'string' ? obj['timezone'] : defaults.timezone),
    privacyMode: obj['privacyMode'] === true,
    emailEnabled: obj['emailEnabled'] === undefined ? defaults.emailEnabled : obj['emailEnabled'] === true,
    daily: {
      enabled: daily['enabled'] === true,
      hour: parseInteger(daily['hour'], defaults.daily.hour, 0, 23, '日报发送时段'),
      skipIfEmpty: daily['skipIfEmpty'] === undefined ? defaults.daily.skipIfEmpty : daily['skipIfEmpty'] === true,
      ...(parseRuleChannels(daily['channels']) !== undefined ? { channels: parseRuleChannels(daily['channels']) } : {}),
    },
    weekly: {
      enabled: weekly['enabled'] === true,
      dayOfWeek: parseInteger(weekly['dayOfWeek'], defaults.weekly.dayOfWeek, 1, 7, '周报发送星期'),
      hour: parseInteger(weekly['hour'], defaults.weekly.hour, 0, 23, '周报发送时段'),
      ...(parseRuleChannels(weekly['channels']) !== undefined ? { channels: parseRuleChannels(weekly['channels']) } : {}),
    },
    monthly: {
      enabled: monthly['enabled'] === true,
      mode: monthlyMode,
      paydayDay: parseInteger(monthly['paydayDay'], defaults.monthly.paydayDay, 1, 31, '发薪日'),
      hour: parseInteger(monthly['hour'], defaults.monthly.hour, 0, 23, '月报发送时段'),
      ...(parseRuleChannels(monthly['channels']) !== undefined ? { channels: parseRuleChannels(monthly['channels']) } : {}),
    },
    inactivity: {
      enabled: inactivity['enabled'] === true,
      days: parseInteger(inactivity['days'], defaults.inactivity.days, 1, 60, '未记账提醒天数'),
      cooldownDays: parseInteger(inactivity['cooldownDays'], defaults.inactivity.cooldownDays, 1, 30, '未记账冷却天数'),
      hour: parseInteger(inactivity['hour'], defaults.inactivity.hour, 0, 23, '未记账提醒时段'),
      ...(parseRuleChannels(inactivity['channels']) !== undefined ? { channels: parseRuleChannels(inactivity['channels']) } : {}),
    },
    billDue: {
      enabled: billDue['enabled'] === true,
      daysBefore: parseInteger(billDue['daysBefore'], defaults.billDue.daysBefore, 0, 14, '账单提前提醒天数'),
      hour: parseInteger(billDue['hour'], defaults.billDue.hour, 0, 23, '账单提醒时段'),
      ...(parseRuleChannels(billDue['channels']) !== undefined ? { channels: parseRuleChannels(billDue['channels']) } : {}),
    },
    dca: {
      enabled: dca['enabled'] === true,
      daysBefore: parseInteger(dca['daysBefore'], defaults.dca.daysBefore, 0, 14, '定投提前提醒天数'),
      hour: parseInteger(dca['hour'], defaults.dca.hour, 0, 23, '定投提醒时段'),
      ...(parseRuleChannels(dca['channels']) !== undefined ? { channels: parseRuleChannels(dca['channels']) } : {}),
    },
    calendar: {
      enabled: calendar['enabled'] === true,
      daysBefore: parseInteger(calendar['daysBefore'], defaults.calendar.daysBefore, 0, 14, '日历提前提醒天数'),
      hour: parseInteger(calendar['hour'], defaults.calendar.hour, 0, 23, '日历提醒时段'),
      ...(parseRuleChannels(calendar['channels']) !== undefined ? { channels: parseRuleChannels(calendar['channels']) } : {}),
    },
    budgetAlert: {
      enabled: budgetAlert['enabled'] === true,
      warnPercent: parseInteger(budgetAlert['warnPercent'], defaults.budgetAlert.warnPercent, 50, 99, '预算预警阈值'),
      ...(parseRuleChannels(budgetAlert['channels']) !== undefined ? { channels: parseRuleChannels(budgetAlert['channels']) } : {}),
    },
    fixedAsset: {
      enabled: fixedAsset['enabled'] === true,
      daysBefore: parseInteger(fixedAsset['daysBefore'], defaults.fixedAsset.daysBefore, 0, 60, '物品提前提醒天数'),
      hour: parseInteger(fixedAsset['hour'], defaults.fixedAsset.hour, 0, 23, '物品提醒时段'),
      ...(parseRuleChannels(fixedAsset['channels']) !== undefined ? { channels: parseRuleChannels(fixedAsset['channels']) } : {}),
    },
    pushChannels: parsePushChannels(obj['pushChannels']),
  };
}

export function maskUserNotificationPreferences(prefs: UserNotificationPreferences): UserNotificationPreferences {
  return {
    ...prefs,
    pushChannels: prefs.pushChannels.map((ch) => (
      ch.format === 'bark' ? { ...ch, deviceKey: ch.deviceKey ? SECRET_PLACEHOLDER : '' } : ch
    )),
  };
}

export function mergeUserNotificationSecrets(
  next: UserNotificationPreferences,
  stored?: UserNotificationPreferences,
): UserNotificationPreferences {
  if (!stored) return next;
  const byName = new Map(stored.pushChannels.map((ch) => [ch.name, ch]));
  return {
    ...next,
    pushChannels: next.pushChannels.map((ch) => {
      if (ch.format !== 'bark' || ch.deviceKey !== SECRET_PLACEHOLDER) return ch;
      const prev = byName.get(ch.name);
      return prev?.format === 'bark' ? { ...ch, deviceKey: prev.deviceKey } : { ...ch, deviceKey: '' };
    }),
  };
}

export function anyNotificationEnabled(prefs: UserNotificationPreferences): boolean {
  return prefs.daily.enabled
    || prefs.weekly.enabled
    || prefs.monthly.enabled
    || prefs.inactivity.enabled
    || prefs.billDue.enabled
    || prefs.dca.enabled
    || prefs.calendar.enabled
    || prefs.budgetAlert.enabled
    || prefs.fixedAsset.enabled;
}

// ─────────────────────────── Rendering (Text + HTML) ───────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(amount: string, currency: Pick<ReportCurrencySummary, 'symbol' | 'assetCode'>, privacyMode: boolean): string {
  if (privacyMode) return '****';
  return currency.symbol ? `${currency.symbol}${amount}` : `${amount} ${currency.assetCode}`;
}

function formatDeltaBadge(currency: ReportCurrencySummary, privacyMode: boolean): string {
  if (currency.expenseDeltaPercent === null) return '上期无支出对比';
  const sign = Number(currency.expenseDeltaPercent) > 0 ? '+' : '';
  if (privacyMode) return `较上期 ${sign}${currency.expenseDeltaPercent}%`;
  const deltaSign = Number(currency.expenseDelta) > 0 ? '+' : '';
  return `较上期 ${sign}${currency.expenseDeltaPercent}%（${deltaSign}${formatMoney(currency.expenseDelta, currency, false)}）`;
}

export function renderReportPlainText(digest: LedgerReportDigest): { subject: string; text: string } {
  const c = digest.primaryCurrency;
  const subject = `【资产账本】${digest.period.label}`;
  const lines: string[] = [
    subject,
    `统计周期：${digest.period.from} 至 ${digest.period.to}`,
    `记账笔数：${digest.totalTransactionCount} 笔（活跃 ${c.activeDays} 天）`,
  ];
  if (digest.isEmpty) {
    lines.push('', '本周期暂无收支记录。');
  } else {
    lines.push(
      '',
      `总支出：${formatMoney(c.expense, c, digest.privacyMode)}（${formatDeltaBadge(c, digest.privacyMode)}）`,
      `总收入：${formatMoney(c.income, c, digest.privacyMode)}`,
      `净结余：${formatMoney(c.net, c, digest.privacyMode)}${c.savingsRatePercent !== null ? `（储蓄率 ${c.savingsRatePercent}%）` : ''}`,
    );
    if (c.topCategories.length > 0) {
      lines.push('', '支出分类 Top 5：');
      for (const row of c.topCategories) {
        lines.push(`- ${row.categoryName}：${formatMoney(row.amount, c, digest.privacyMode)}（${row.sharePercent}%）`);
      }
    }
    if (c.topExpenses.length > 0) {
      lines.push('', '大额支出 Top 3：');
      for (const row of c.topExpenses) {
        lines.push(`- ${row.date} ${row.title}（${row.categoryName}）：${formatMoney(row.amount, c, digest.privacyMode)}`);
      }
    }
    if (digest.otherCurrencies.length > 0) {
      lines.push('', '其他币种汇总：');
      for (const other of digest.otherCurrencies) {
        lines.push(`- ${other.assetCode}：支出 ${formatMoney(other.expense, other, digest.privacyMode)} / 收入 ${formatMoney(other.income, other, digest.privacyMode)}（${other.transactionCount} 笔）`);
      }
    }
  }
  return { subject, text: lines.join('\n') };
}

export function renderReportHtml(digest: LedgerReportDigest): string {
  const c = digest.primaryCurrency;
  const modeTag = digest.period.mode === 'payday_auto'
    ? '智能发薪月（按薪资收入自动切分）'
    : digest.period.mode === 'payday'
      ? `发薪月（每月 ${digest.period.paydayDay} 日起）`
      : digest.period.mode === 'calendar'
        ? '自然月'
        : digest.kind === 'weekly'
          ? '周报'
          : '日报';

  const categoriesHtml = c.topCategories.length === 0
    ? `<p style="margin:0;color:${EMAIL_THEME.fgSubtle};font-size:13px;">本周期暂无分类支出。</p>`
    : c.topCategories.map((row) => {
      const pct = Math.max(0, Math.min(100, Number(row.sharePercent) || 0));
      return `<div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;font-variant-numeric:tabular-nums;">
          <span style="color:${EMAIL_THEME.fg};font-weight:600;">${escapeHtml(row.categoryName)}</span>
          <span style="font-family:${EMAIL_THEME.fontNumeric};color:${EMAIL_THEME.fgMuted};">${escapeHtml(formatMoney(row.amount, c, digest.privacyMode))} · ${escapeHtml(row.sharePercent)}%</span>
        </div>
        <div style="height:6px;background:${EMAIL_THEME.surface2};border-radius:2px;border-bottom:1px solid ${EMAIL_THEME.border};overflow:hidden;">
          <div style="height:6px;width:${pct}%;background:${EMAIL_THEME.accent};border-radius:2px 2px 0 0;"></div>
        </div>
      </div>`;
    }).join('');

  const topExpensesHtml = c.topExpenses.length === 0
    ? ''
    : `<div style="margin-top:24px;padding-top:16px;border-top:2px solid ${EMAIL_THEME.borderStrong};">
        <h3 style="margin:0 0 10px;font-size:14px;color:${EMAIL_THEME.fg};font-weight:700;">大额支出 Top 3</h3>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;">
          ${c.topExpenses.map((row) => `<tr>
            <td style="padding:8px 0;border-bottom:1px solid ${EMAIL_THEME.borderRow};font-family:${EMAIL_THEME.fontNumeric};color:${EMAIL_THEME.fgSubtle};width:88px;">${escapeHtml(row.date)}</td>
            <td style="padding:8px 8px;border-bottom:1px solid ${EMAIL_THEME.borderRow};color:${EMAIL_THEME.fg};">${escapeHtml(row.title)} <span style="color:${EMAIL_THEME.fgSubtle};">· ${escapeHtml(row.categoryName)}</span></td>
            <td style="padding:8px 0;border-bottom:1px solid ${EMAIL_THEME.borderRow};font-family:${EMAIL_THEME.fontNumeric};color:${EMAIL_THEME.negative};font-weight:700;text-align:right;white-space:nowrap;">${escapeHtml(formatMoney(row.amount, c, digest.privacyMode))}</td>
          </tr>`).join('')}
        </table>
      </div>`;

  const otherCurrenciesHtml = digest.otherCurrencies.length === 0
    ? ''
    : `<div style="margin-top:20px;padding:12px 14px;background:${EMAIL_THEME.surface2};border-radius:4px;border:1px solid ${EMAIL_THEME.border};border-top:2px solid ${EMAIL_THEME.borderStrong};">
        <div style="font-size:13px;font-weight:700;color:${EMAIL_THEME.fg};margin-bottom:6px;">其他币种汇总</div>
        ${digest.otherCurrencies.map((other) => `<div style="font-size:12px;color:${EMAIL_THEME.fgMuted};line-height:1.7;font-family:${EMAIL_THEME.fontNumeric};font-variant-numeric:tabular-nums;">
          <strong style="color:${EMAIL_THEME.fg};">${escapeHtml(other.assetCode)}</strong>：支出 ${escapeHtml(formatMoney(other.expense, other, digest.privacyMode))} · 收入 ${escapeHtml(formatMoney(other.income, other, digest.privacyMode))} · ${other.transactionCount} 笔
        </div>`).join('')}
      </div>`;

  const bodyHtml = digest.isEmpty
    ? `<p style="margin:8px 0;color:${EMAIL_THEME.fgSubtle};font-size:14px;">本周期暂无收支记录。</p>`
    : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:2px solid ${EMAIL_THEME.borderStrong};border-bottom:1px solid ${EMAIL_THEME.border};font-variant-numeric:tabular-nums;">
        <tr>
          <td style="width:33.3%;padding:14px 10px 14px 0;vertical-align:top;border-right:1px solid ${EMAIL_THEME.borderRow};">
            <div style="font-size:12px;color:${EMAIL_THEME.fgSubtle};">总支出</div>
            <div style="font-family:${EMAIL_THEME.fontNumeric};font-size:20px;font-weight:700;color:${EMAIL_THEME.negative};margin-top:4px;">${escapeHtml(formatMoney(c.expense, c, digest.privacyMode))}</div>
            <div style="font-size:11px;color:${EMAIL_THEME.fgSubtle};margin-top:4px;">${escapeHtml(formatDeltaBadge(c, digest.privacyMode))}</div>
          </td>
          <td style="width:33.3%;padding:14px 10px 14px 0;vertical-align:top;border-right:1px solid ${EMAIL_THEME.borderRow};">
            <div style="font-size:12px;color:${EMAIL_THEME.fgSubtle};">总收入</div>
            <div style="font-family:${EMAIL_THEME.fontNumeric};font-size:20px;font-weight:700;color:${EMAIL_THEME.positive};margin-top:4px;">${escapeHtml(formatMoney(c.income, c, digest.privacyMode))}</div>
            <div style="font-size:11px;color:${EMAIL_THEME.fgSubtle};margin-top:4px;">活跃记账 ${c.activeDays} 天</div>
          </td>
          <td style="width:33.3%;padding:14px 0 14px 10px;vertical-align:top;">
            <div style="font-size:12px;color:${EMAIL_THEME.fgSubtle};">净结余</div>
            <div style="font-family:${EMAIL_THEME.fontNumeric};font-size:20px;font-weight:700;color:${EMAIL_THEME.fg};margin-top:4px;">${escapeHtml(formatMoney(c.net, c, digest.privacyMode))}</div>
            <div style="font-size:11px;color:${EMAIL_THEME.fgSubtle};margin-top:4px;">${c.savingsRatePercent !== null ? `储蓄率 ${escapeHtml(c.savingsRatePercent)}%` : '—'}</div>
          </td>
        </tr>
      </table>
      <div style="margin-top:22px;">
        <h3 style="margin:0 0 12px;font-size:14px;color:${EMAIL_THEME.fg};font-weight:700;">支出分类 Top 5</h3>
        ${categoriesHtml}
      </div>
      ${topExpensesHtml}
      ${otherCurrenciesHtml}`;

  return renderLedgerEmailShell({
    badge: modeTag,
    sealText: '有本清册',
    title: digest.period.label,
    subtitle: `周期：${digest.period.from} 至 ${digest.period.to} · 共 ${digest.totalTransactionCount} 笔记录`,
    accentColor: EMAIL_THEME.accent,
    maxWidth: 600,
    bodyHtml,
    footerText: '本报告由您在有本中主动开启的定时统计自动生成，可在「我的账号 → 报告与提醒」中随时调整周期或关闭。',
  });
}

function renderEditorialReminderHtml(input: {
  badge: string;
  title: string;
  subtitle: string;
  accentColor: string;
  rows: Array<{ label: string; meta: string; right: string; rightTone?: string }>;
  emptyNote?: string;
}): string {
  const bodyHtml = input.rows.length === 0
    ? `<p style="margin:0;color:${EMAIL_THEME.fgSubtle};font-size:14px;line-height:1.7;">${escapeHtml(input.emptyNote ?? '当前没有待处理事项。')}</p>`
    : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:2px solid ${EMAIL_THEME.borderStrong};font-size:13px;font-variant-numeric:tabular-nums;">
        ${input.rows.map((row) => `<tr>
          <td style="padding:10px 8px 10px 0;border-bottom:1px solid ${EMAIL_THEME.borderRow};color:${EMAIL_THEME.fg};">
            <div style="font-weight:600;">${escapeHtml(row.label)}</div>
            <div style="font-size:12px;color:${EMAIL_THEME.fgSubtle};margin-top:2px;">${escapeHtml(row.meta)}</div>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid ${EMAIL_THEME.borderRow};font-family:${EMAIL_THEME.fontNumeric};text-align:right;white-space:nowrap;font-weight:700;color:${row.rightTone ?? EMAIL_THEME.fg};">${escapeHtml(row.right)}</td>
        </tr>`).join('')}
      </table>`;

  return renderLedgerEmailShell({
    badge: input.badge,
    sealText: '有本提醒',
    title: input.title,
    subtitle: input.subtitle,
    accentColor: input.accentColor,
    maxWidth: 560,
    bodyHtml,
    footerText: '可在「我的账号 → 报告与提醒」中调整提醒天数、推送渠道或关闭此提醒。',
  });
}

export function renderInactivityMessage(status: InactivityReminderStatus): {
  subject: string;
  text: string;
  html: string;
} {
  const days = status.daysSinceLastTransaction ?? status.thresholdDays;
  const subject = `【有本】已经 ${days} 天没有记账啦`;
  const lastLine = status.lastTransactionDate
    ? `上次记账日期：${status.lastTransactionDate}（距今 ${days} 天）`
    : '账本尚未记录近期流水';
  const text = `${subject}\n\n${lastLine}\n提醒阈值：连续 ${status.thresholdDays} 天未记账。\n打开有本补记一下最近的花销吧，保持好习惯！`;
  const html = renderEditorialReminderHtml({
    badge: '记账习惯提醒',
    title: `已经 ${days} 天没有记账啦`,
    subtitle: lastLine,
    accentColor: '#76531c',
    rows: [
      {
        label: '抽 1 分钟补记最近的花销',
        meta: `当前提醒阈值：连续 ${status.thresholdDays} 天未记账`,
        right: `${days} 天未记`,
        rightTone: '#76531c',
      },
    ],
  });
  return { subject, text, html };
}

function daysUntilLabel(days: number): string {
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  return `${days} 天后`;
}

export function renderBillDueMessage(status: BillDueReminderStatus): {
  subject: string;
  text: string;
  html: string;
} {
  const count = status.items.length;
  const subject = count > 0
    ? `【有本】${count} 笔账单即将到期还款`
    : '【有本】账单还款到期提醒';
  const lines = count === 0
    ? [subject, '', `未来 ${status.daysBefore} 天内暂无即将到期的信用卡或贷款账单。`]
    : [
      subject,
      `统计日期：${status.today}（提前 ${status.daysBefore} 天提醒）`,
      '',
      ...status.items.map((item) => `- ${item.accountName}（${item.kind === 'credit_card' ? '信用卡' : '贷款'}）：${item.dueDate} 到期（${daysUntilLabel(item.daysUntil)}）`),
    ];
  const html = renderEditorialReminderHtml({
    badge: '账单还款提醒',
    title: count > 0 ? `${count} 笔账单即将到期` : '暂无即将到期的账单',
    subtitle: `检查日期：${status.today} · 提前 ${status.daysBefore} 天提醒`,
    accentColor: '#b63226',
    emptyNote: `未来 ${status.daysBefore} 天内暂无即将到期的信用卡或贷款账单。`,
    rows: status.items.map((item) => ({
      label: item.accountName,
      meta: `${item.kind === 'credit_card' ? '信用卡' : '贷款'} · 还款日 ${item.dueDate}${item.statementDay ? `（账单日每月 ${item.statementDay} 日）` : ''}`,
      right: daysUntilLabel(item.daysUntil),
      rightTone: item.daysUntil <= 1 ? '#a72f24' : '#76531c',
    })),
  });
  return { subject, text: lines.join('\n'), html };
}

export function renderDcaMessage(status: DcaReminderStatus, privacyMode = false): {
  subject: string;
  text: string;
  html: string;
} {
  const count = status.items.length;
  const subject = count > 0
    ? `【有本】${count} 项定投计划待执行`
    : '【有本】定投计划提醒';
  const amountText = (item: DcaReminderStatus['items'][number]) => (
    privacyMode
      ? '****'
      : item.baseCurrencySymbol
        ? `${item.baseCurrencySymbol}${item.plannedAmount}`
        : `${item.plannedAmount} ${item.baseCurrencyCode}`
  );
  const lines = count === 0
    ? [subject, '', `未来 ${status.daysBefore} 天内暂无待执行的定投计划。`]
    : [
      subject,
      `统计日期：${status.today}`,
      '',
      ...status.items.map((item) => `- ${item.planName}（${item.targetAssetCode}）：计划 ${item.scheduledDate}（${daysUntilLabel(item.daysUntil)}），金额 ${amountText(item)}`),
    ];
  const html = renderEditorialReminderHtml({
    badge: '定投计划提醒',
    title: count > 0 ? `${count} 项定投计划待执行` : '暂无待执行的定投计划',
    subtitle: `检查日期：${status.today} · 提前 ${status.daysBefore} 天提醒`,
    accentColor: '#2b6079',
    emptyNote: `未来 ${status.daysBefore} 天内暂无待执行的定投计划。`,
    rows: status.items.map((item) => ({
      label: `${item.planName} · ${item.targetAssetCode}`,
      meta: `计划日期 ${item.scheduledDate} · 计划投入 ${amountText(item)}`,
      right: daysUntilLabel(item.daysUntil),
      rightTone: item.daysUntil <= 0 ? '#a72f24' : '#2b6079',
    })),
  });
  return { subject, text: lines.join('\n'), html };
}

export function renderCalendarMessage(status: CalendarReminderStatus): {
  subject: string;
  text: string;
  html: string;
} {
  const count = status.items.length;
  const subject = count > 0
    ? `【有本】近期有 ${count} 个生日 / 纪念日`
    : '【有本】日历生日与纪念日提醒';
  const kindLabel = (k: 'birthday' | 'anniversary') => (k === 'birthday' ? '生日' : '纪念日');
  const lines = count === 0
    ? [subject, '', `未来 ${status.daysBefore} 天内暂无生日或纪念日。`]
    : [
      subject,
      `统计日期：${status.today}（提前 ${status.daysBefore} 天提醒）`,
      '',
      ...status.items.map((item) => `- ${item.title}（${item.calendar === 'lunar' ? '农历' : '阳历'}${kindLabel(item.kind)}${item.age ? ` · ${item.age} 岁` : ''}）：${item.date}（${daysUntilLabel(item.daysUntil)}）`),
    ];
  const html = renderEditorialReminderHtml({
    badge: '日历生日与纪念日',
    title: count > 0 ? `近期有 ${count} 个重要日子` : '近期暂无生日或纪念日',
    subtitle: `检查日期：${status.today} · 提前 ${status.daysBefore} 天提醒`,
    accentColor: '#b63226',
    emptyNote: `未来 ${status.daysBefore} 天内暂无生日或纪念日。`,
    rows: status.items.map((item) => ({
      label: item.title,
      meta: `${item.calendar === 'lunar' ? '农历' : '阳历'}${kindLabel(item.kind)}${item.age ? ` · ${item.age} 岁` : ''} · ${item.date}`,
      right: daysUntilLabel(item.daysUntil),
      rightTone: item.daysUntil === 0 ? '#b63226' : '#211d18',
    })),
  });
  return { subject, text: lines.join('\n'), html };
}

export function renderBudgetAlertMessage(status: BudgetAlertStatus, privacyMode = false): {
  subject: string;
  text: string;
  html: string;
} {
  const count = status.items.length;
  const overCount = status.items.filter((i) => i.level === 'over').length;
  const subject = count > 0
    ? (overCount > 0 ? `【有本】${overCount} 项分类预算已超支` : `【有本】${count} 项分类预算达到预警线`)
    : '【有本】预算超支预警';
  const moneyText = (amount: string, item: BudgetAlertStatus['items'][number]) => (
    privacyMode ? '****' : item.symbol ? `${item.symbol}${amount}` : `${amount} ${item.assetCode}`
  );
  const lines = count === 0
    ? [subject, '', `${status.month} 本月各项分类预算均在安全范围内（预警线 ${status.warnPercent}%）。`]
    : [
      subject,
      `预算月份：${status.month}（预警线 ${status.warnPercent}%）`,
      '',
      ...status.items.map((item) => `- ${item.categoryName}：已用 ${moneyText(item.spentAmount, item)} / 预算 ${moneyText(item.plannedAmount, item)}（${item.usagePercent}%${item.level === 'over' ? '，已超支' : '，接近上限'}）`),
    ];
  const html = renderEditorialReminderHtml({
    badge: '预算超支预警',
    title: count > 0
      ? (overCount > 0 ? `${overCount} 项分类预算已超支` : `${count} 项分类预算接近上限`)
      : '本月预算执行健康',
    subtitle: `预算月份：${status.month} · 预警阈值 ${status.warnPercent}% / 100%`,
    accentColor: '#a72f24',
    emptyNote: `${status.month} 本月各项分类预算均未达到 ${status.warnPercent}% 预警线。`,
    rows: status.items.map((item) => ({
      label: item.categoryName,
      meta: `已支出 ${moneyText(item.spentAmount, item)} / 预算 ${moneyText(item.plannedAmount, item)}`,
      right: `${item.usagePercent}%${item.level === 'over' ? ' 超支' : ''}`,
      rightTone: item.level === 'over' ? '#a72f24' : '#76531c',
    })),
  });
  return { subject, text: lines.join('\n'), html };
}

export function renderFixedAssetMessage(status: FixedAssetReminderStatus): {
  subject: string;
  text: string;
  html: string;
} {
  const count = status.items.length;
  const subject = count > 0
    ? `【有本】${count} 项物品耗材或质保需要关注`
    : '【有本】物品耗材与质保提醒';
  const lines = count === 0
    ? [subject, '', `未来 ${status.daysBefore} 天内暂无到期的质保/维保或低余量耗材。`]
    : [
      subject,
      `检查日期：${status.today}（提前 ${status.daysBefore} 天提醒）`,
      '',
      ...status.items.map((item) => `- ${item.label}：${item.detail}（${item.remainingText ?? daysUntilLabel(item.daysUntil ?? 0)}）`),
    ];
  const html = renderEditorialReminderHtml({
    badge: '物品耗材与质保',
    title: count > 0 ? `${count} 项物品需要关注` : '物品状态良好',
    subtitle: `检查日期：${status.today} · 提前 ${status.daysBefore} 天提醒`,
    accentColor: '#76531c',
    emptyNote: `未来 ${status.daysBefore} 天内暂无即将到期的质保、维保或低余量耗材。`,
    rows: status.items.map((item) => ({
      label: item.label,
      meta: item.detail,
      right: item.remainingText ?? daysUntilLabel(item.daysUntil ?? 0),
      rightTone: item.remainingText === '已耗尽' || (item.daysUntil !== undefined && item.daysUntil <= 1) ? '#a72f24' : '#76531c',
    })),
  });
  return { subject, text: lines.join('\n'), html };
}

// ─────────────────────────── Multi-channel push delivery ───────────────────────────

export function buildPushPayload(
  channel: WebhookChannel,
  message: { title: string; text: string; kind: UserNotificationKind | 'test'; periodKey: string },
): { contentType: string; body: string } {
  const json = (value: unknown): { contentType: string; body: string } => ({
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
  switch (channel.format) {
    case 'bark':
      return json({
        device_key: channel.deviceKey,
        title: message.title,
        body: message.text,
        ...(channel.group ? { group: channel.group } : {}),
      });
    case 'slack':
      return json({ text: message.text });
    case 'discord':
      return json({ content: message.text });
    case 'feishu':
      return json({ msg_type: 'text', content: { text: message.text } });
    case 'dingtalk':
      return json({ msgtype: 'text', text: { content: message.text } });
    case 'wecom':
      return json({ msgtype: 'text', text: { content: message.text } });
    case 'text':
      return { contentType: 'text/plain; charset=utf-8', body: message.text };
    default:
      return json(message);
  }
}

export type PushDeliverer = (
  channel: WebhookChannel,
  message: { title: string; text: string; kind: UserNotificationKind | 'test'; periodKey: string },
) => Promise<void>;

export async function defaultPushDeliverer(
  channel: WebhookChannel,
  message: { title: string; text: string; kind: UserNotificationKind | 'test'; periodKey: string },
): Promise<void> {
  const payload = buildPushPayload(channel, message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': payload.contentType },
      body: payload.body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── Execution & Scheduler ───────────────────────────

export interface UserReportRunnerDeps {
  store: SyncServerStore;
  previewOptions: LedgerPreviewOptions;
  emailAvailable: () => boolean;
  sendEmail: (to: string, subject: string, body: string, html?: string) => Promise<void>;
  sendPush?: PushDeliverer;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', action: string, message: string, meta?: Record<string, unknown>) => Promise<void>;
}

function isoWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const wd = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

function activeBaseCurrencyAssetId(backup: LedgerBackup): string | undefined {
  const settings = (backup.settings ?? []) as Setting[];
  const active = settings.find((row) => !row.isDeleted);
  return active?.baseCurrencyAssetId;
}

function extractDigestFromBackup(
  backup: LedgerBackup,
  kind: 'daily' | 'weekly' | 'monthly',
  today: string,
  prefs: UserNotificationPreferences,
  target: 'completed' | 'current',
): LedgerReportDigest | null {
  let periods: { period: LedgerReportDigest['period']; previousPeriod: LedgerReportDigest['previousPeriod'] } | null;
  if (kind === 'daily') {
    periods = dailyReportPeriods(target === 'completed' && prefs.daily.hour < 12 ? addDays(today, -1) : today);
  } else if (kind === 'weekly') {
    periods = weeklyReportPeriods(today, target);
  } else if (prefs.monthly.mode === 'payday_auto') {
    periods = smartPaydayReportPeriods(today, backup.transactions ?? [], backup.categories ?? [], { target });
  } else {
    periods = monthlyReportPeriods(today, {
      mode: prefs.monthly.mode,
      paydayDay: prefs.monthly.paydayDay,
      target,
    });
  }
  if (!periods) return null;

  return buildLedgerReportDigest({
    kind,
    period: periods.period,
    previousPeriod: periods.previousPeriod,
    transactions: backup.transactions ?? [],
    transactionSplits: backup.transactionSplits ?? [],
    refundAllocations: backup.refundAllocations ?? [],
    categories: backup.categories ?? [],
    assets: (backup.assets ?? []) as Asset[],
    baseCurrencyAssetId: activeBaseCurrencyAssetId(backup),
    privacyMode: prefs.privacyMode,
  });
}

async function deliverToConfiguredChannels(
  deps: UserReportRunnerDeps,
  username: string,
  prefs: UserNotificationPreferences,
  message: { title: string; text: string; html: string; kind: UserNotificationKind | 'test'; routeKind?: UserNotificationKind; periodKey: string },
): Promise<{ status: 'sent' | 'partial' | 'failed' | 'skipped'; results: ChannelResult[] }> {
  const results: ChannelResult[] = [];
  const routeKind = message.routeKind ?? (message.kind === 'test' ? undefined : message.kind);
  const selectedChannels = ruleChannelsForKind(prefs, routeKind);
  const allowEmail = selectedChannels === undefined || selectedChannels.includes('email');

  if (prefs.emailEnabled && allowEmail) {
    const emailInfo = await deps.store.accountEmail(username);
    if (!emailInfo.email || !emailInfo.verifiedAt) {
      results.push({ name: '账号邮箱', kind: 'email', state: 'skipped', error: '邮箱未验证' });
    } else if (!deps.emailAvailable()) {
      results.push({ name: '账号邮箱', kind: 'email', state: 'skipped', error: '服务器未配置邮件渠道' });
    } else {
      try {
        await deps.sendEmail(emailInfo.email, message.title, message.text, message.html);
        results.push({ name: '账号邮箱', kind: 'email', state: 'sent' });
      } catch (error) {
        results.push({
          name: '账号邮箱',
          kind: 'email',
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const pushDeliverer = deps.sendPush ?? defaultPushDeliverer;
  for (const channel of prefs.pushChannels) {
    if (!channel.enabled) continue;
    if (selectedChannels !== undefined && !selectedChannels.includes(`webhook:${channel.name}`)) continue;
    try {
      await pushDeliverer(channel, {
        title: message.title,
        text: message.text,
        kind: message.kind,
        periodKey: message.periodKey,
      });
      results.push({ name: channel.name, kind: 'webhook', state: 'sent' });
    } catch (error) {
      results.push({
        name: channel.name,
        kind: 'webhook',
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sentCount = results.filter((r) => r.state === 'sent').length;
  const failedCount = results.filter((r) => r.state === 'failed').length;
  const status = sentCount > 0 && failedCount === 0
    ? 'sent'
    : sentCount > 0 && failedCount > 0
      ? 'partial'
      : failedCount > 0
        ? 'failed'
        : 'skipped';
  return { status, results };
}

export async function previewUserNotification(
  deps: UserReportRunnerDeps,
  username: string,
  kind: UserNotificationKind,
): Promise<{ subject: string; text: string; html: string; periodKey: string }> {
  const raw = await deps.store.getNotificationSettings(username);
  const prefs = raw ? parseUserNotificationPreferences(JSON.parse(raw)) : defaultUserNotificationPreferences();
  const now = (deps.now ?? (() => new Date()))();
  const zoned = zonedCalendarNow(now, prefs.timezone);
  const { backup } = await buildLedgerBackup(deps.previewOptions, username);

  if (kind === 'inactivity') {
    const status = evaluateInactivityReminder({
      today: zoned.date,
      thresholdDays: prefs.inactivity.days,
      transactions: backup.transactions ?? [],
    });
    const rendered = renderInactivityMessage(status);
    return { ...rendered, periodKey: `preview:inactivity:${zoned.date}` };
  }
  if (kind === 'bill_due') {
    const status = evaluateBillDueReminders({
      today: zoned.date,
      daysBefore: prefs.billDue.daysBefore,
      accounts: (backup.accounts ?? []) as Account[],
    });
    const rendered = renderBillDueMessage(status);
    return { ...rendered, periodKey: `preview:bill_due:${zoned.date}` };
  }
  if (kind === 'dca') {
    const status = evaluateDcaReminders({
      today: zoned.date,
      daysBefore: prefs.dca.daysBefore,
      dcaPlans: (backup.dcaPlans ?? []) as DcaPlan[],
      dcaExecutions: (backup.dcaExecutions ?? []) as DcaExecution[],
      assets: (backup.assets ?? []) as Asset[],
    });
    const rendered = renderDcaMessage(status, prefs.privacyMode);
    return { ...rendered, periodKey: `preview:dca:${zoned.date}` };
  }
  if (kind === 'calendar') {
    const status = evaluateCalendarReminders({
      today: zoned.date,
      daysBefore: prefs.calendar.daysBefore,
      entries: backup.calendarEntries ?? [],
      states: backup.calendarOccurrenceStates ?? [],
    });
    const rendered = renderCalendarMessage(status);
    return { ...rendered, periodKey: `preview:calendar:${zoned.date}` };
  }
  if (kind === 'budget_alert') {
    const status = evaluateBudgetAlerts({
      today: zoned.date,
      warnPercent: prefs.budgetAlert.warnPercent,
      budgetCategories: backup.budgetCategories ?? [],
      transactions: backup.transactions ?? [],
      transactionSplits: backup.transactionSplits ?? [],
      refundAllocations: backup.refundAllocations ?? [],
      categories: backup.categories ?? [],
      assets: (backup.assets ?? []) as Asset[],
    });
    const rendered = renderBudgetAlertMessage(status, prefs.privacyMode);
    return { ...rendered, periodKey: `preview:budget_alert:${zoned.date.slice(0, 7)}` };
  }
  if (kind === 'fixed_asset') {
    const status = evaluateFixedAssetReminders({
      today: zoned.date,
      daysBefore: prefs.fixedAsset.daysBefore,
      fixedAssets: (backup.fixedAssets ?? []) as FixedAsset[],
      consumables: (backup.fixedAssetConsumables ?? []) as FixedAssetConsumable[],
      usageMetrics: (backup.fixedAssetUsageMetrics ?? []) as FixedAssetUsageMetric[],
      usageLogs: (backup.fixedAssetUsageLogs ?? []) as FixedAssetUsageLog[],
    });
    const rendered = renderFixedAssetMessage(status);
    return { ...rendered, periodKey: `preview:fixed_asset:${zoned.date}` };
  }

  // For smart payday preview, prefer the most recent completed salary cycle if available, otherwise current.
  const digest = (kind === 'monthly' && prefs.monthly.mode === 'payday_auto'
    ? extractDigestFromBackup(backup, 'monthly', zoned.date, prefs, 'completed')
      ?? extractDigestFromBackup(backup, 'monthly', zoned.date, prefs, 'current')
    : extractDigestFromBackup(backup, kind, zoned.date, prefs, 'current'))!;
  const rendered = renderReportPlainText(digest);
  const html = renderReportHtml(digest);
  return { subject: rendered.subject, text: rendered.text, html, periodKey: digest.period.periodKey };
}

export async function sendTestUserNotification(
  deps: UserReportRunnerDeps,
  username: string,
  kind: UserNotificationKind,
): Promise<{ subject: string; summary: string; status: 'sent' | 'partial' | 'failed' | 'skipped'; results: ChannelResult[] }> {
  const raw = await deps.store.getNotificationSettings(username);
  const prefs = raw ? parseUserNotificationPreferences(JSON.parse(raw)) : defaultUserNotificationPreferences();
  const now = (deps.now ?? (() => new Date()))();
  const preview = await previewUserNotification(deps, username, kind);
  const subject = `[测试] ${preview.subject}`;
  const periodKey = `test:${preview.periodKey}`;

  const delivery = await deliverToConfiguredChannels(deps, username, prefs, {
    title: subject,
    text: preview.text,
    html: preview.html,
    kind: 'test',
    routeKind: kind,
    periodKey,
  });

  await deps.store.recordNotificationDelivery({
    eventKey: `test:${username}:${kind}:${now.toISOString()}:${Math.random().toString(36).slice(2, 8)}`,
    username,
    kind: 'test',
    periodKey,
    status: delivery.status,
    channelsJson: JSON.stringify(delivery.results),
    summary: subject,
  });

  return { subject, summary: preview.text.split('\n').slice(0, 3).join(' · '), status: delivery.status, results: delivery.results };
}

export async function runDueUserNotifications(deps: UserReportRunnerDeps): Promise<{ processedUsers: number; deliveries: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.store.listNotificationSettings();
  let processedUsers = 0;
  let deliveries = 0;

  for (const row of rows) {
    let prefs: UserNotificationPreferences;
    try {
      prefs = parseUserNotificationPreferences(JSON.parse(row.configJson));
    } catch {
      continue;
    }
    if (!anyNotificationEnabled(prefs)) continue;

    const hasAnyChannel = prefs.emailEnabled || prefs.pushChannels.some((ch) => ch.enabled);
    if (!hasAnyChannel) continue;

    const zoned = zonedCalendarNow(now, prefs.timezone);
    const currentHour = Number(zoned.time.slice(0, 2));
    const dueKinds: Array<{ kind: UserNotificationKind; eventKey: string; periodKey: string }> = [];

    if (prefs.daily.enabled && currentHour >= prefs.daily.hour) {
      const targetDay = prefs.daily.hour < 12 ? addDays(zoned.date, -1) : zoned.date;
      const periodKey = `daily:${targetDay}`;
      const eventKey = `${row.username}:${periodKey}`;
      if (!await deps.store.hasNotificationDelivery(eventKey)) {
        dueKinds.push({ kind: 'daily', eventKey, periodKey });
      }
    }

    if (prefs.weekly.enabled && isoWeekday(zoned.date) === prefs.weekly.dayOfWeek && currentHour >= prefs.weekly.hour) {
      const { period } = weeklyReportPeriods(zoned.date, 'completed');
      const eventKey = `${row.username}:${period.periodKey}`;
      if (!await deps.store.hasNotificationDelivery(eventKey)) {
        dueKinds.push({ kind: 'weekly', eventKey, periodKey: period.periodKey });
      }
    }

    if (prefs.monthly.enabled && currentHour >= prefs.monthly.hour) {
      if (prefs.monthly.mode === 'payday_auto') {
        // Smart payday cycles depend on recorded salary transactions; inspect after replay.
        dueKinds.push({ kind: 'monthly', eventKey: '', periodKey: '' });
      } else if (isMonthlyReportDueDay(zoned.date, prefs.monthly.mode, prefs.monthly.paydayDay)) {
        const { period } = monthlyReportPeriods(zoned.date, {
          mode: prefs.monthly.mode,
          paydayDay: prefs.monthly.paydayDay,
          target: 'completed',
        });
        const eventKey = `${row.username}:${period.periodKey}`;
        if (!await deps.store.hasNotificationDelivery(eventKey)) {
          dueKinds.push({ kind: 'monthly', eventKey, periodKey: period.periodKey });
        }
      }
    }

    if (prefs.inactivity.enabled && currentHour >= prefs.inactivity.hour) {
      const periodKey = `inactivity:${zoned.date}`;
      const eventKey = `${row.username}:${periodKey}`;
      if (!await deps.store.hasNotificationDelivery(eventKey)) {
        const lastSent = await deps.store.lastInactivityDeliveryDay(row.username);
        const cooledDown = !lastSent || daysBetween(lastSent, zoned.date) >= prefs.inactivity.cooldownDays;
        if (cooledDown) {
          dueKinds.push({ kind: 'inactivity', eventKey, periodKey });
        }
      }
    }

    if (prefs.billDue.enabled && currentHour >= prefs.billDue.hour) {
      const periodKey = `bill_due:${zoned.date}`;
      const eventKey = `${row.username}:${periodKey}`;
      if (!await deps.store.hasNotificationDelivery(eventKey)) {
        dueKinds.push({ kind: 'bill_due', eventKey, periodKey });
      }
    }

    if (prefs.dca.enabled && currentHour >= prefs.dca.hour) {
      const periodKey = `dca:${zoned.date}`;
      const eventKey = `${row.username}:${periodKey}`;
      if (!await deps.store.hasNotificationDelivery(eventKey)) {
        dueKinds.push({ kind: 'dca', eventKey, periodKey });
      }
    }

    if (prefs.calendar.enabled && currentHour >= prefs.calendar.hour) {
      const periodKey = `calendar:${zoned.date}`;
      const eventKey = `${row.username}:${periodKey}`;
      if (!await deps.store.hasNotificationDelivery(eventKey)) {
        dueKinds.push({ kind: 'calendar', eventKey, periodKey });
      }
    }

    if (prefs.budgetAlert.enabled) {
      // Budget alerts evaluate on every pass so crossing 80% / 100% triggers promptly;
      // per-(month, category, level) keys prevent duplicate alerts.
      dueKinds.push({ kind: 'budget_alert', eventKey: '', periodKey: `budget_alert:${zoned.date.slice(0, 7)}` });
    }

    if (prefs.fixedAsset.enabled && currentHour >= prefs.fixedAsset.hour) {
      const periodKey = `fixed_asset:${zoned.date}`;
      const eventKey = `${row.username}:${periodKey}`;
      if (!await deps.store.hasNotificationDelivery(eventKey)) {
        dueKinds.push({ kind: 'fixed_asset', eventKey, periodKey });
      }
    }

    if (dueKinds.length === 0) continue;
    processedUsers += 1;

    let backup: LedgerBackup;
    try {
      ({ backup } = await buildLedgerBackup(deps.previewOptions, row.username));
    } catch (error) {
      await deps.log?.('warn', 'user_report_replay_failed', 'Skipped user report because ledger replay failed', {
        username: row.username,
        detail: { reason: error instanceof Error ? error.message : String(error) },
      });
      continue;
    }

    for (const item of dueKinds) {
      if (item.kind === 'inactivity') {
        const status = evaluateInactivityReminder({
          today: zoned.date,
          thresholdDays: prefs.inactivity.days,
          transactions: backup.transactions ?? [],
        });
        if (!status.shouldRemind) continue;
        const rendered = renderInactivityMessage(status);
        const delivery = await deliverToConfiguredChannels(deps, row.username, prefs, {
          title: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          kind: 'inactivity',
          periodKey: item.periodKey,
        });
        await deps.store.recordNotificationDelivery({
          eventKey: item.eventKey,
          username: row.username,
          kind: 'inactivity',
          periodKey: item.periodKey,
          status: delivery.status,
          channelsJson: JSON.stringify(delivery.results),
          summary: rendered.subject,
        });
        deliveries += 1;
        continue;
      }

      if (item.kind === 'bill_due') {
        const status = evaluateBillDueReminders({
          today: zoned.date,
          daysBefore: prefs.billDue.daysBefore,
          accounts: (backup.accounts ?? []) as Account[],
        });
        if (status.items.length === 0) continue;
        const rendered = renderBillDueMessage(status);
        const delivery = await deliverToConfiguredChannels(deps, row.username, prefs, {
          title: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          kind: 'bill_due',
          periodKey: item.periodKey,
        });
        await deps.store.recordNotificationDelivery({
          eventKey: item.eventKey,
          username: row.username,
          kind: 'bill_due',
          periodKey: item.periodKey,
          status: delivery.status,
          channelsJson: JSON.stringify(delivery.results),
          summary: rendered.subject,
        });
        deliveries += 1;
        continue;
      }

      if (item.kind === 'dca') {
        const status = evaluateDcaReminders({
          today: zoned.date,
          daysBefore: prefs.dca.daysBefore,
          dcaPlans: (backup.dcaPlans ?? []) as DcaPlan[],
          dcaExecutions: (backup.dcaExecutions ?? []) as DcaExecution[],
          assets: (backup.assets ?? []) as Asset[],
        });
        if (status.items.length === 0) continue;
        const rendered = renderDcaMessage(status, prefs.privacyMode);
        const delivery = await deliverToConfiguredChannels(deps, row.username, prefs, {
          title: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          kind: 'dca',
          periodKey: item.periodKey,
        });
        await deps.store.recordNotificationDelivery({
          eventKey: item.eventKey,
          username: row.username,
          kind: 'dca',
          periodKey: item.periodKey,
          status: delivery.status,
          channelsJson: JSON.stringify(delivery.results),
          summary: rendered.subject,
        });
        deliveries += 1;
        continue;
      }

      if (item.kind === 'calendar') {
        const status = evaluateCalendarReminders({
          today: zoned.date,
          daysBefore: prefs.calendar.daysBefore,
          entries: backup.calendarEntries ?? [],
          states: backup.calendarOccurrenceStates ?? [],
        });
        if (status.items.length === 0) continue;
        const rendered = renderCalendarMessage(status);
        const delivery = await deliverToConfiguredChannels(deps, row.username, prefs, {
          title: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          kind: 'calendar',
          periodKey: item.periodKey,
        });
        await deps.store.recordNotificationDelivery({
          eventKey: item.eventKey,
          username: row.username,
          kind: 'calendar',
          periodKey: item.periodKey,
          status: delivery.status,
          channelsJson: JSON.stringify(delivery.results),
          summary: rendered.subject,
        });
        deliveries += 1;
        continue;
      }

      if (item.kind === 'budget_alert') {
        const fullStatus = evaluateBudgetAlerts({
          today: zoned.date,
          warnPercent: prefs.budgetAlert.warnPercent,
          budgetCategories: backup.budgetCategories ?? [],
          transactions: backup.transactions ?? [],
          transactionSplits: backup.transactionSplits ?? [],
          refundAllocations: backup.refundAllocations ?? [],
          categories: backup.categories ?? [],
          assets: (backup.assets ?? []) as Asset[],
        });
        const newlyCrossed = [];
        for (const alert of fullStatus.items) {
          const alertKey = `${row.username}:budget_alert:${alert.month}:${alert.categoryId}:${alert.level}`;
          if (!await deps.store.hasNotificationDelivery(alertKey)) {
            newlyCrossed.push({ alert, alertKey });
          }
        }
        if (newlyCrossed.length === 0) continue;
        const filteredStatus = { ...fullStatus, items: newlyCrossed.map((entry) => entry.alert) };
        const rendered = renderBudgetAlertMessage(filteredStatus, prefs.privacyMode);
        const delivery = await deliverToConfiguredChannels(deps, row.username, prefs, {
          title: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          kind: 'budget_alert',
          periodKey: item.periodKey,
        });
        for (const entry of newlyCrossed) {
          await deps.store.recordNotificationDelivery({
            eventKey: entry.alertKey,
            username: row.username,
            kind: 'budget_alert',
            periodKey: `${entry.alert.month}:${entry.alert.categoryId}:${entry.alert.level}`,
            status: delivery.status,
            channelsJson: JSON.stringify(delivery.results),
            summary: `${rendered.subject}（${entry.alert.categoryName} ${entry.alert.usagePercent}%）`,
          });
        }
        deliveries += 1;
        continue;
      }

      if (item.kind === 'fixed_asset') {
        const status = evaluateFixedAssetReminders({
          today: zoned.date,
          daysBefore: prefs.fixedAsset.daysBefore,
          fixedAssets: (backup.fixedAssets ?? []) as FixedAsset[],
          consumables: (backup.fixedAssetConsumables ?? []) as FixedAssetConsumable[],
          usageMetrics: (backup.fixedAssetUsageMetrics ?? []) as FixedAssetUsageMetric[],
          usageLogs: (backup.fixedAssetUsageLogs ?? []) as FixedAssetUsageLog[],
        });
        if (status.items.length === 0) continue;
        const rendered = renderFixedAssetMessage(status);
        const delivery = await deliverToConfiguredChannels(deps, row.username, prefs, {
          title: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          kind: 'fixed_asset',
          periodKey: item.periodKey,
        });
        await deps.store.recordNotificationDelivery({
          eventKey: item.eventKey,
          username: row.username,
          kind: 'fixed_asset',
          periodKey: item.periodKey,
          status: delivery.status,
          channelsJson: JSON.stringify(delivery.results),
          summary: rendered.subject,
        });
        deliveries += 1;
        continue;
      }

      const digest = extractDigestFromBackup(backup, item.kind, zoned.date, prefs, 'completed');
      if (!digest) continue;
      const periodKey = item.periodKey || digest.period.periodKey;
      const eventKey = item.eventKey || `${row.username}:${periodKey}`;
      if (!item.eventKey && await deps.store.hasNotificationDelivery(eventKey)) continue;
      if (item.kind === 'daily' && prefs.daily.skipIfEmpty && digest.isEmpty) {
        await deps.store.recordNotificationDelivery({
          eventKey,
          username: row.username,
          kind: 'daily',
          periodKey,
          status: 'skipped',
          channelsJson: '[]',
          summary: `${digest.period.label}（无交易已跳过）`,
        });
        continue;
      }

      const rendered = renderReportPlainText(digest);
      const html = renderReportHtml(digest);
      const delivery = await deliverToConfiguredChannels(deps, row.username, prefs, {
        title: rendered.subject,
        text: rendered.text,
        html,
        kind: item.kind,
        periodKey,
      });
      await deps.store.recordNotificationDelivery({
        eventKey,
        username: row.username,
        kind: item.kind,
        periodKey,
        status: delivery.status,
        channelsJson: JSON.stringify(delivery.results),
        summary: rendered.subject,
      });
      deliveries += 1;
    }
  }

  return { processedUsers, deliveries };
}
