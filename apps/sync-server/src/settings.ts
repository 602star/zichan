/**
 * Effective runtime settings.
 *
 * Only an explicit allow-list is editable online. Saved settings take precedence
 * over deployment defaults, and secrets are never returned.
 */
import { ServerStoreError, type SyncServerStore } from './store.js';
import { parseBackupWindow } from './backup-schedule.js';
import { parseAlertChannels } from './alert-channels.js';
import { isAbsolute } from 'node:path';

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
    name: 'adminAccessPath', label: '管理后台安全路径', kind: 'text', textFormat: 'free',
    envVar: 'ADMIN_ACCESS_PATH', default: '',
    description: '留空使用 /admin/；填写后入口为 /安全路径/admin/。修改后旧入口立即失效。自定义路径不限长度，仅使用字母、数字、下划线或连字符；短路径容易被猜到。',
  },
  {
    name: 'defaultCommitQuotaBytes', label: '默认加密提交配额', kind: 'number', unit: 'bytes',
    envVar: 'COMMIT_QUOTA_BYTES', default: 20 * 1024 ** 3,
    min: 1024 ** 2, max: 1024 ** 4,
    description: '未单独设置配额的普通账号和只读运维账号使用此上限；所有者与管理员无限额。调低后不会删除已有数据。',
  },
  {
    name: 'defaultBlobQuotaBytes', label: '默认附件配额', kind: 'number', unit: 'bytes',
    envVar: 'ATTACHMENT_QUOTA_BYTES', default: 20 * 1024 ** 3,
    min: 1024 ** 2, max: 1024 ** 4,
    description: '未单独设置配额的普通账号和只读运维账号使用此上限；附件回收区和暂存上传也计入用量。',
  },
  {
    name: 'attachmentMaxFileBytes', label: '单文件附件上限', kind: 'number', unit: 'bytes',
    envVar: 'ATTACHMENT_MAX_FILE_BYTES', default: 100 * 1024 ** 2,
    min: 1024 ** 2, max: 1024 ** 3,
    description: '服务器接受的单个附件大小；网页端同时使用此值校验。已保存的附件不受影响。',
  },
  {
    name: 'attachmentTrashRetentionMs', label: '附件回收区保留时间', kind: 'number', unit: 'ms',
    envVar: 'ATTACHMENT_TRASH_RETENTION_MS', default: 30 * 24 * 60 * 60 * 1000,
    min: 24 * 60 * 60 * 1000, max: 3650 * 24 * 60 * 60 * 1000,
    description: '超过此时间的回收区附件在后续清理时删除；缩短时间可能使已有回收内容到期。',
  },
  {
    name: 'backupAutoEnabled',
    label: '自动备份',
    kind: 'select',
    envVar: 'ADMIN_BACKUP_AUTO',
    default: 'off',
    options: ['off', 'on'],
    description: '默认关闭。配置绝对备份路径与维护窗口后，执行器会在窗口内短暂停服、备份校验并恢复服务。每个窗口最多尝试一次，失败不会反复重试。',
  },
  {
    name: 'backupDirectory',
    label: '备份位置（部署侧实际路径）',
    kind: 'text',
    textFormat: 'free',
    envVar: 'ADMIN_BACKUP_DIRECTORY',
    default: '',
    maxLength: 300,
    description: '服务器上的绝对路径；执行器需要写入权限。不得与服务器数据目录或公开网页目录互相包含。',
  },
  {
    name: 'backupWindow',
    label: '维护窗口（如 周日 03:00-04:00）',
    kind: 'text',
    textFormat: 'free',
    envVar: 'ADMIN_BACKUP_WINDOW',
    default: '',
    maxLength: 64,
    description: '支持 每天 03:00-04:00、周日 03:00-04:00 或 Sun 03:00-04:00，使用服务器本地时区。可跨午夜；窗口内启动一次，完成后恢复服务，错过的窗口不补跑。',
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
    label: '邮件与 Webhook 通知渠道',
    kind: 'text',
    textFormat: 'json',
    envVar: 'ADMIN_ALERT_CHANNELS',
    default: '',
    maxLength: 8000,
    description: '可同时配置 SMTP 邮件与 Webhook（包括 Bark）。留空则回退到单一 Webhook 地址。邮件渠道也用于账号验证和密码找回。',
  },
  {
    name: 'ledgerWebAccess',
    label: '允许用户通过本站网页记账',
    kind: 'select',
    envVar: 'ADMIN_LEDGER_WEB_ACCESS',
    default: 'on',
    options: ['on', 'off'],
    description: '关闭后普通记账账号不能在本站登录、续期或访问账本；节点间复制和管理后台继续运行。已有离线浏览器缓存不会被远程删除。',
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
    description: '更早的分钟级监控指标会在下一次例行清理时删除。',
  },
  {
    name: 'httpErrorRateWarnPercent', label: 'HTTP 错误率告警阈值（%）', kind: 'number',
    envVar: 'ADMIN_HTTP_ERROR_RATE_WARN_PERCENT', default: 20, min: 1, max: 100,
    description: '最近 5 分钟内 HTTP 4xx/5xx 占比达到该值，且请求量达到最小样本数后告警。连续两次异常才触发。',
  },
  {
    name: 'slowRequestRateWarnPercent', label: '慢请求率告警阈值（%）', kind: 'number',
    envVar: 'ADMIN_SLOW_REQUEST_RATE_WARN_PERCENT', default: 20, min: 1, max: 100,
    description: '最近 5 分钟内耗时至少 1 秒的请求占比达到该值，且请求量达到最小样本数后告警。',
  },
  {
    name: 'requestAlertMinCount', label: '请求告警最小样本数', kind: 'number',
    envVar: 'ADMIN_REQUEST_ALERT_MIN_COUNT', default: 20, min: 1, max: 100_000,
    description: 'HTTP 错误率和慢请求率规则只在最近 5 分钟达到这个请求数后评估，避免极低流量产生误报。',
  },
  {
    name: 'metricsHourRetentionDays', label: '小时级指标保留天数', kind: 'number',
    envVar: 'ADMIN_METRICS_HOUR_DAYS', default: 90, min: 7, max: 730,
    description: '更早的小时级监控指标会在下一次例行清理时删除。',
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
  defaultValue: number | string;
  name: string;
  label: string;
  kind: SettingField['kind'];
  unit?: string;
  description: string;
  stored: number | string | null;
  envVar: string;
  source: 'env' | 'database' | 'default';
  overridesEnv?: boolean;
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
    if (field.name !== 'adminAccessPath' && trimmed.length > (field.maxLength ?? 500)) return undefined;
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
  if ((field.unit === 'bytes' || field.unit === 'ms' || field.name.endsWith('RetentionDays')) && !Number.isSafeInteger(numeric)) return undefined;
  if (field.min !== undefined && numeric < field.min) return undefined;
  if (field.max !== undefined && numeric > field.max) return undefined;
  return numeric;
}

/** Throws instead of silently falling back, so a typo cannot look like a saved setting. */
export function parseSettingValue(field: SettingField, value: unknown): number | string {
  const coerced = coerce(field, value);
  if (coerced === undefined) {
    const bounds = field.name === 'adminAccessPath'
      ? '（留空使用 /admin/；自定义值仅使用字母、数字、下划线或连字符；不能使用 api）'
      : field.kind === 'number'
      ? `（${String(field.min)}–${String(field.max)}）`
      : field.kind === 'select'
        ? `（${(field.options ?? []).join('、')}）`
        : (field.textFormat ?? 'url') === 'url'
          ? `（需为 http(s) 地址，留空表示不通知；最多 ${String(field.maxLength ?? 500)} 个字符）`
          : `（最多 ${String(field.maxLength ?? 500)} 个字符，留空表示未配置）`;
    throw new ServerStoreError('INVALID_SETTING', 400, `${field.label} 取值无效${bounds}`);
  }
  if (field.name === 'adminAccessPath') {
    const segment = String(coerced);
    if (!segment) return '';
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new ServerStoreError('INVALID_SETTING', 400, '管理后台安全路径只能使用字母、数字、下划线或连字符');
    if (segment.toLowerCase() === 'api') throw new ServerStoreError('INVALID_SETTING', 400, '管理后台安全路径不能使用保留字 api');
  }
  if (field.name === 'alertChannels') {
    try { parseAlertChannels(coerced); }
    catch (error) { throw new ServerStoreError('INVALID_SETTING', 400, error instanceof Error ? error.message : String(error)); }
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
export function assertMaintenancePlan(next: Record<string, number | string>, validateSchedule = true): void {
  if (next['backupAutoEnabled'] !== 'on') return;
  const missing = (next['backupDirectory'] ? '' : '备份位置') + (next['backupWindow'] ? '' : '、维护窗口');
  if (missing === '') {
    // Legacy versions allowed free-text window descriptions. Keep HTTP available so owners
    // can correct them; the executor reports an error and refuses to stop the service.
    if (!validateSchedule) return;
    if (!isAbsolute(String(next['backupDirectory']))) throw new ServerStoreError('INVALID_SETTING', 400, '自动备份位置必须为绝对路径');
    try { parseBackupWindow(String(next['backupWindow'])); }
    catch (error) { throw new ServerStoreError('INVALID_SETTING', 400, error instanceof Error ? error.message : String(error)); }
    return;
  }
  throw new ServerStoreError('INVALID_SETTING', 400, `启用自动备份前必须先配置${missing}`);
}

export function createSettings(store: SyncServerStore, env: NodeJS.ProcessEnv = process.env, options: {
  defaults?: Record<string, number | string>;
  onChange?: (values: Record<string, number | string>) => void;
} = {}) {
  let cache: Record<string, number | string> | undefined;
  let cachedAt = 0;
  /** Saved values override deployment values, which only seed the initial effective policy. */
  const effectiveFrom = (stored: Record<string, number | string>): Record<string, number | string> => {
    const values: Record<string, number | string> = {};
    for (const field of SETTING_FIELDS) {
      const saved = stored[field.name];
      if (saved !== undefined) {
        values[field.name] = saved;
        continue;
      }
      const fromEnv = env[field.envVar];
      if (fromEnv !== undefined && fromEnv !== '') {
        const parsed = field.name === 'adminAccessPath' ? parseSettingValue(field, fromEnv) : coerce(field, fromEnv);
        if (parsed === undefined) throw new Error(`环境变量 ${field.envVar} 取值无效：${fromEnv}（${field.label}）；请修正或删除该变量，不会静默回退默认值`);
        values[field.name] = parsed;
        continue;
      }
      values[field.name] = options.defaults?.[field.name] ?? field.default;
    }
    return values;
  };


  const load = async (): Promise<Record<string, number | string>> => {
    if (cache && Date.now() - cachedAt < 5_000) return cache;
    const loaded: Record<string, number | string> = {};
    for (const field of SETTING_FIELDS) {
      const raw = await store.maintenanceState(`${SETTING_PREFIX}${field.name}`);
      if (raw && raw['value'] !== undefined) {
        const parsed = field.name === 'adminAccessPath' ? parseSettingValue(field, raw['value']) : coerce(field, raw['value']);
        if (parsed !== undefined) loaded[field.name] = parsed;
      }
    }
    const effective = effectiveFrom(loaded);
    assertMaintenancePlan(effective, false);
    cache = loaded;
    cachedAt = Date.now();
    options.onChange?.(effective);
    return loaded;
  };

  const resolve = (field: SettingField, stored: Record<string, number | string>): EffectiveSetting => {

    const fromEnv = env[field.envVar];
    const storedValue = stored[field.name] ?? null;
    const fallback = options.defaults?.[field.name] ?? field.default;
    let value: number | string = fallback;
    let source: EffectiveSetting['source'] = 'default';
    if (storedValue === null && fromEnv !== undefined && fromEnv !== '') {
      const parsed = field.name === 'adminAccessPath' ? parseSettingValue(field, fromEnv) : coerce(field, fromEnv);
      if (parsed === undefined) {
        throw new Error(`环境变量 ${field.envVar} 取值无效：${fromEnv}（${field.label}）；请修正或删除该变量，不会静默回退默认值`);
      }
      value = parsed;
      source = 'env';
    }
    if (storedValue !== null) { value = storedValue; source = 'database'; }
    return {
      name: field.name,
      label: field.label,
      kind: field.kind,
      ...(field.unit ? { unit: field.unit } : {}),
      description: field.description,
      defaultValue: fallback,
      stored: storedValue,
      envVar: field.envVar,
      source,
      overridesEnv: storedValue !== null && fromEnv !== undefined && fromEnv !== '',
      value,
      ...(field.min === undefined ? {} : { minimum: field.min }),
      ...(field.max === undefined ? {} : { maximum: field.max }),
      ...(field.options ? { options: field.options } : {}),
      ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      ...(field.textFormat === undefined ? {} : { textFormat: field.textFormat }),
      editable: true,
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
      const validated: [SettingField, number | string | null][] = [];
      for (const [name, value] of Object.entries(updates)) {
        const field = FIELD_BY_NAME.get(name);
        if (!field) throw new ServerStoreError('UNKNOWN_SETTING', 400, `不支持的设置项：${name}`);
        validated.push([field, value === null ? null : parseSettingValue(field, value)]);
      }
      const next = { ...(cache ?? await load()) };
      for (const [field, value] of validated) {
        if (value === null) delete next[field.name];
        else next[field.name] = value;
      }
      assertMaintenancePlan(effectiveFrom(next));
      for (const [field, value] of validated) {
        await store.setMaintenanceState(`${SETTING_PREFIX}${field.name}`, value === null ? {} : { value });
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
