/**
 * Effective runtime settings.
 *
 * Only an explicit allow-list is editable online. Secrets are never returned, and a
 * value coming from the environment is shown as such instead of being silently
 * overridden by, or overriding, the stored one.
 */
import { ServerStoreError, type JsonRecord, type SyncServerStore } from './store.js';

export interface SettingField {
  name: string;
  label: string;
  kind: 'number' | 'select';
  /** Environment variable that takes precedence over the stored value. */
  envVar: string;
  default: number | string;
  min?: number;
  max?: number;
  options?: string[];
  unit?: string;
  /** Settings that shape alerts rather than requests. */
  description: string;
}

export const SETTING_FIELDS: SettingField[] = [
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
    name: 'metricsMinuteRetentionDays',
    label: '分钟级指标保留天数',
    kind: 'number',
    envVar: 'ADMIN_METRICS_MINUTE_DAYS',
    default: 7,
    min: 1,
    max: 90,
    description: '更早的分钟级分桶会被清理；小时级分桶保留 90 天。',
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
  editable: boolean;
}

function coerce(field: SettingField, value: unknown): number | string | undefined {
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
    const bounds = field.kind === 'number' ? `（${String(field.min)}–${String(field.max)}）` : `（${(field.options ?? []).join('、')}）`;
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

export function createSettings(store: SyncServerStore, env: NodeJS.ProcessEnv = process.env) {
  let cache: Record<string, number | string> | undefined;
  let cachedAt = 0;

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
