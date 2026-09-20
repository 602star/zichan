/**
 * Effective runtime settings.
 *
 * Only an explicit allow-list is editable online. Secrets are never returned, and a
 * value coming from the environment is shown as such instead of being silently
 * overridden by, or overriding, the stored one.
 */
import { ServerStoreError, type SyncServerStore } from './store.js';

export interface SettingField {
  name: string;
  label: string;
  kind: 'number' | 'select' | 'text';
  /** Environment variable that takes precedence over the stored value. */
  envVar: string;
  default: number | string;
  min?: number;
  max?: number;
  /** Upper bound for text fields, e.g. a URL that must not be unbounded. */
  maxLength?: number;
  /**
   * Only for `kind: 'text'`. `url` requires an http(s) address; `free` accepts any
   * trimmed string up to `maxLength` (a path or a window label is not a URL); `json` accepts
   * anything that parses, so a structured value (the alert channel list) is validated by its own
   * parser instead of here.
   */
  textFormat?: 'url' | 'free' | 'json';
  options?: string[];
  unit?: string;
  /** Settings that shape alerts rather than requests. */
  description: string;
}

export const SETTING_FIELDS: SettingField[] = [
  {
    name: 'backupAutoEnabled',
    label: '自动备份',
    kind: 'select',
    envVar: 'ADMIN_BACKUP_AUTO',
    default: 'off',
    options: ['off', 'on'],
    description: '默认关闭。必须同时配置备份位置与维护窗口才能启用；实际备份仍由部署侧在其维护窗口内执行。',
  },
  {
    name: 'backupDirectory',
    label: '备份位置（部署侧实际路径）',
    kind: 'text',
    textFormat: 'free',
    envVar: 'ADMIN_BACKUP_DIRECTORY',
    default: '',
    maxLength: 300,
    description: '声明备份写到哪里，用于计划展示与启用前检查；后台不会读写这个目录。',
  },
  {
    name: 'backupWindow',
    label: '维护窗口（如 周日 03:00-04:00）',
    kind: 'text',
    textFormat: 'free',
    envVar: 'ADMIN_BACKUP_WINDOW',
    default: '',
    maxLength: 64,
    description: '停服备份与恢复演练只允许在该窗口内进行；没有窗口就视为没有计划，不能启用自动备份。',
  },
  {
    name: 'backupRetentionCount',
    label: '保留的成功备份份数',
    kind: 'number',
    envVar: 'ADMIN_BACKUP_RETENTION',
    default: 3,
    min: 1,
    max: 100,
    description: '备份保留只清理已经校验成功的历史备份，并始终保留最近一个有效备份。',
  },
  {
    name: 'alertChannels',
    label: '告警通知渠道（JSON 数组）',
    kind: 'text',
    textFormat: 'json',
    envVar: 'ADMIN_ALERT_CHANNELS',
    default: '',
    maxLength: 8000,
    description: '可同时配置多个渠道：webhook（generic/slack/discord/feishu/dingtalk/wecom/text）与 email（SMTP）。留空则回退到上面的单一 Webhook 地址。每个渠道的投递结果分别记录，一个渠道失败不影响其它渠道。',
  },
  {
    name: 'requireAdminMfa',
    label: '要求管理员启用两步验证',
    kind: 'select',
    envVar: 'ADMIN_REQUIRE_MFA',
    default: 'off',
    options: ['off', 'on'],
    description: '开启后管理后台登录需要已验证的两步验证；所有管理员都完成绑定后才允许开启。本地恢复流程不受影响，用于紧急找回访问。',
  },
  {
    name: 'alertWebhookUrl',
    label: '告警外部通知地址（Webhook）',
    kind: 'text',
    envVar: 'ADMIN_ALERT_WEBHOOK_URL',
    default: '',
    maxLength: 500,
    textFormat: 'url',
    description: '告警转为活动或恢复时向该地址 POST 一条 JSON；留空表示只在本页展示，不对外通知。配置了下面的「告警通知渠道」时以渠道列表为准。',
  },
  {
    name: 'quotaWarnRatio',
    label: '容量告警阈值（占配额比例）',
    kind: 'number',
    envVar: 'ADMIN_QUOTA_WARN_RATIO',
    default: 0.9,
    min: 0.5,
    max: 1,
    description: '账号提交或附件用量达到该比例时产生容量告警。',
  },
  {
    name: 'syncErrorWarnCount',
    label: '同步错误告警阈值（每 5 分钟次数）',
    kind: 'number',
    envVar: 'ADMIN_SYNC_ERROR_WARN_COUNT',
    default: 20,
    min: 1,
    max: 10_000,
    description: '滚动窗口内同步失败次数达到该值并持续两个采样周期时产生告警。',
  },
  {
    name: 'backupIntervalHours',
    label: '备份预期间隔（小时，0 表示不检查）',
    kind: 'number',
    envVar: 'ADMIN_BACKUP_INTERVAL_HOURS',
    default: 0,
    min: 0,
    max: 720,
    description: '超过该间隔没有成功备份时产生告警；默认关闭。',
  },
  {
    name: 'logRetention',
    label: '运行日志保留条数',
    kind: 'number',
    envVar: 'ADMIN_LOG_RETENTION',
    default: 5_000,
    min: 500,
    max: 200_000,
    description: '超过部分按时间顺序裁剪；不影响管理审计与诊断事件。',
  },
  {
    name: 'syncEventRetention',
    label: '同步诊断事件保留条数',
    kind: 'number',
    envVar: 'ADMIN_SYNC_EVENT_RETENTION',
    default: 20_000,
    min: 1_000,
    max: 500_000,
    description: '诊断事件使用独立保留策略，不被日志裁剪带走。',
  },
  {
    name: 'auditRetention',
    label: '管理审计保留条数',
    kind: 'number',
    envVar: 'ADMIN_AUDIT_RETENTION',
    default: 50_000,
    min: 1_000,
    max: 1_000_000,
    description: '管理审计是"查历史"的表，因此保留上限比运行日志高得多；裁剪只按时间顺序删除最旧的记录。',
  },
  {
    name: 'auditFailureRetention',
    label: '失败管理尝试保留条数',
    kind: 'number',
    envVar: 'ADMIN_AUDIT_FAILURE_RETENTION',
    default: 2_000,
    min: 200,
    max: 100_000,
    description: '被拒绝或回滚的管理尝试（权限不足、受保护账号、结构冲突等）单独保留，默认与旧行为一致的 2000 条。',
  },
  {
    name: 'metricsMinuteRetentionDays',
    label: '分钟级指标保留天数',
    kind: 'number',
    envVar: 'ADMIN_METRICS_MINUTE_DAYS',
    default: 7,
    min: 1,
    max: 90,
    description: '更早的分钟级分桶会被清理；小时级分桶保留 90 天。',
  },
  {
    name: 'memoryWarnBytes',
    label: '进程内存告警阈值（MiB，0 表示只按容器上限判断）',
    kind: 'number',
    envVar: 'ADMIN_MEMORY_WARN_MB',
    default: 0,
    min: 0,
    max: 1_048_576,
    description: '常驻内存超过该值时告警。容器部署通常不需要设置：容器内存上限优先，达到 85% 告警、95% 记为严重。',
  },
  {
    name: 'eventLoopLagWarnMs',
    label: '事件循环延迟告警阈值（毫秒）',
    kind: 'number',
    envVar: 'ADMIN_EVENT_LOOP_WARN_MS',
    default: 50,
    min: 10,
    max: 5_000,
    description: '单线程 Node 上这一项直接反映同步任务是否堵住了请求处理。默认 50 毫秒已高于 Windows 约 16 毫秒的定时器粒度；设得过低会在空闲时也持续告警。',
  },
  {
    name: 'cpuWarnPercent',
    label: '进程 CPU 告警阈值（%）',
    kind: 'number',
    envVar: 'ADMIN_CPU_WARN_PERCENT',
    default: 90,
    min: 10,
    max: 100,
    description: '按采样窗口平均计算，瞬时尖峰不会触发；单核满负荷约为 100%。',
  },
];

const FIELD_BY_NAME = new Map(SETTING_FIELDS.map((field) => [field.name, field]));
const SETTING_PREFIX = 'setting:';

export interface EffectiveSetting {
  name: string;
  label: string;
  kind: SettingField['kind'];
  unit?: string;
  description: string;
  stored: number | string | null;
  envVar: string;
  source: 'env' | 'database' | 'default';
  value: number | string;
  minimum?: number;
  maximum?: number;
  options?: string[];
  maxLength?: number;
  textFormat?: SettingField['textFormat'];
  editable: boolean;
}

function coerce(field: SettingField, value: unknown): number | string | undefined {
  if (field.kind === 'text') {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    // An empty value is a real choice ("no external channel"), not an invalid one.
    if (!trimmed) return '';
    if (trimmed.length > (field.maxLength ?? 500)) return undefined;
    if ((field.textFormat ?? 'url') === 'url' && !/^https?:\/\/[^\s]+$/i.test(trimmed)) return undefined;
    // Structure is checked by the feature's own parser at delivery time; here it only has to be
    // JSON, so a malformed list is refused at save rather than discovered when an alert fires.
    if (field.textFormat === 'json') {
      try { JSON.parse(trimmed); } catch { return undefined; }
    }
    return trimmed;
  }
  if (field.kind === 'select') {
    return typeof value === 'string' && field.options?.includes(value) ? value : undefined;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (field.min !== undefined && numeric < field.min) return undefined;
  if (field.max !== undefined && numeric > field.max) return undefined;
  return numeric;
}

/** Throws instead of silently falling back, so a typo cannot look like a saved setting. */
export function parseSettingValue(field: SettingField, value: unknown): number | string {
  const coerced = coerce(field, value);
  if (coerced === undefined) {
    const bounds = field.kind === 'number'
      ? `（${String(field.min)}–${String(field.max)}）`
      : field.kind === 'select'
        ? `（${(field.options ?? []).join('、')}）`
        : (field.textFormat ?? 'url') === 'url'
          ? `（需为 http(s) 地址，留空表示不通知；最多 ${String(field.maxLength ?? 500)} 个字符）`
          : `（最多 ${String(field.maxLength ?? 500)} 个字符，留空表示未配置）`;
    throw new ServerStoreError('INVALID_SETTING', 400, `${field.label} 取值无效${bounds}`);
  }
  return coerced;
}

export interface SettingsReader {
  stored: Record<string, number | string>;
  resolve(field: SettingField): EffectiveSetting;
  effective(name: string): number | string;
  save(updates: Record<string, unknown>): Promise<EffectiveSetting[]>;
}

/**
 * Rules that span fields. Enabling automatic backup without a declared location and window
 * describes a schedule nobody can keep, so it is refused instead of stored.
 */
export function assertMaintenancePlan(next: Record<string, number | string>): void {
  if (next['backupAutoEnabled'] !== 'on') return;
  const missing = (next['backupDirectory'] ? '' : '备份位置') + (next['backupWindow'] ? '' : '、维护窗口');
  if (missing === '') return;
  throw new ServerStoreError('INVALID_SETTING', 400, `启用自动备份前必须先配置${missing}`);
}

export function createSettings(store: SyncServerStore, env: NodeJS.ProcessEnv = process.env) {
  let cache: Record<string, number | string> | undefined;
  let cachedAt = 0;
  /**
   * Effective values including environment overrides. The cross-field rules have to see what
   * the service will actually run with, not only what is stored.
   */
  const effectiveFrom = (stored: Record<string, number | string>): Record<string, number | string> => {
    const values: Record<string, number | string> = {};
    for (const field of SETTING_FIELDS) {
      const fromEnv = env[field.envVar];
      if (fromEnv !== undefined && fromEnv !== '') {
        const parsed = coerce(field, fromEnv);
        if (parsed === undefined) throw new Error(`环境变量 ${field.envVar} 取值无效：${fromEnv}（${field.label}）；请修正或删除该变量，不会静默回退默认值`);
        values[field.name] = parsed;
        continue;
      }
      values[field.name] = stored[field.name] ?? field.default;
    }
    return values;
  };


  const load = async (): Promise<Record<string, number | string>> => {
    if (cache && Date.now() - cachedAt < 5_000) return cache;
    const loaded: Record<string, number | string> = {};
    for (const field of SETTING_FIELDS) {
      const raw = await store.maintenanceState(`${SETTING_PREFIX}${field.name}`);
      if (raw && raw['value'] !== undefined) {
        const parsed = coerce(field, raw['value']);
        if (parsed !== undefined) loaded[field.name] = parsed;
      }
    }
    assertMaintenancePlan(effectiveFrom(loaded));
    cache = loaded;
    cachedAt = Date.now();
    return loaded;
  };

  const resolve = (field: SettingField, stored: Record<string, number | string>): EffectiveSetting => {

    const fromEnv = env[field.envVar];
    const storedValue = stored[field.name] ?? null;
    let value: number | string = field.default;
    let source: EffectiveSetting['source'] = 'default';
    if (storedValue !== null) { value = storedValue; source = 'database'; }
    if (fromEnv !== undefined && fromEnv !== '') {
      const parsed = coerce(field, fromEnv);
      if (parsed === undefined) {
        throw new Error(`环境变量 ${field.envVar} 取值无效：${fromEnv}（${field.label}）；请修正或删除该变量，不会静默回退默认值`);
      }
      value = parsed;
      source = 'env';
    }
    return {
      name: field.name,
      label: field.label,
      kind: field.kind,
      ...(field.unit ? { unit: field.unit } : {}),
      description: field.description,
      stored: storedValue,
      envVar: field.envVar,
      source,
      value,
      ...(field.min === undefined ? {} : { minimum: field.min }),
      ...(field.max === undefined ? {} : { maximum: field.max }),
      ...(field.options ? { options: field.options } : {}),
      ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      ...(field.textFormat === undefined ? {} : { textFormat: field.textFormat }),
      editable: source !== 'env',
    };
  };

  const settings: SettingsReader = {
    get stored() { return cache ?? {}; },
    resolve(field) { return resolve(field, cache ?? {}); },
    effective(name) {
      const field = FIELD_BY_NAME.get(name);
      if (!field) throw new Error(`unknown setting ${name}`);
      return resolve(field, cache ?? {}).value;
    },
    async save(updates) {
      const validated: [SettingField, number | string][] = [];
      for (const [name, value] of Object.entries(updates)) {
        const field = FIELD_BY_NAME.get(name);
        if (!field) throw new ServerStoreError('UNKNOWN_SETTING', 400, `不支持的设置项：${name}`);
        validated.push([field, parseSettingValue(field, value)]);
      }
      const next = { ...(cache ?? await load()) };
      for (const [field, value] of validated) next[field.name] = value;
      assertMaintenancePlan(next);
      for (const [field, value] of validated) {
        await store.setMaintenanceState(`${SETTING_PREFIX}${field.name}`, { value });
      }
      cache = undefined;
      cachedAt = 0;
      const loaded = await load();
      return SETTING_FIELDS.map((field) => resolve(field, loaded));
    },
  };

  return {
    settings,
    /** Fails fast on startup when an environment override is unparseable. */
    async load(): Promise<Record<string, number | string>> { return load(); },
  };
}

export type SettingsFacade = ReturnType<typeof createSettings>;
