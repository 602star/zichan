import { JOB_TYPES } from './types.js';
import { AUDIT_ACTION_LABELS } from './audit-presentation.js';
export type LogCategory = 'system' | 'access' | 'login' | 'operations' | 'tasks' | 'containers';
export type LogField = { key: string; label: string; column?: boolean; filter?: boolean; kind?: 'time' | 'duration' | 'json' | 'result'; options?: [string, string][]; placeholder?: string; supporting?: string[] };
export interface LogDefinition { path: string; title: string; description: string; fields: LogField[] }

const resultOptions: [string, string][] = [['success', '成功'], ['failure', '失败'], ['blocked', '拦截'], ['challenge', '等待第二因子'], ['logout', '已退出'], ['revoked', '会话撤销']];
const taskOptions: [string, string][] = [['queued', '排队中'], ['running', '执行中'], ['succeeded', '已完成'], ['failed', '失败'], ['cancelled', '已取消'], ['interrupted', '已中断']];
const at: LogField = { key: 'at', label: '时间', kind: 'time', column: true };
const ip: LogField = { key: 'ip', label: '来源 IP', column: true, filter: true };
const request: LogField = { key: 'requestId', label: 'Request ID', column: true, filter: true, placeholder: 'req-…' };
const instance: LogField = { key: 'instanceId', label: '实例', filter: true };

/** One catalogue owns list columns, filters, detail labels and per-category semantics. */
export const LOG_DEFINITIONS: Record<LogCategory, LogDefinition> = {
  system: { path: '/logs', title: '系统日志', description: '按组件和请求定位系统事件，查看脱敏上下文及错误堆栈。', fields: [at,
    { key: 'level', label: '级别', column: true, filter: true, options: [['info', '信息'], ['warn', '警告'], ['error', '错误']] },
    { key: 'component', label: '组件', column: true, filter: true },
    { key: 'message', label: '消息', column: true }, request,
    { key: 'action', label: '事件', filter: true }, { key: 'username', label: '账号', filter: true }, ip, instance,
    { key: 'serviceId', label: '服务' }, { key: 'environment', label: '环境' }, { key: 'status', label: 'HTTP 状态码' },
    { key: 'stack', label: '错误堆栈' }, { key: 'detail', label: '结构化上下文', kind: 'json' }] },
  access: { path: '/access-logs', title: '访问日志', description: 'HTTP 错误与慢请求索引，按方法、状态、耗时、来源和请求 ID 排查。', fields: [at,
    { key: 'method', label: '方法', column: true, filter: true, options: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map((s) => [s, s]) },
    { key: 'route', label: '路由', column: true, filter: true, placeholder: '/api/…/:id' },
    { key: 'status', label: 'HTTP 状态码', column: true, filter: true, placeholder: '例如 500' },
    { key: 'durationMs', label: '耗时 · ms', kind: 'duration', column: true }, ip, request, instance,
    { key: 'minDuration', label: '最小耗时 · ms', filter: true }, { key: 'maxDuration', label: '最大耗时 · ms', filter: true },
    { key: 'origin', label: '请求来源 Origin' }, { key: 'userAgent', label: '用户代理' }, { key: 'ttfbMs', label: '响应头提交耗时 · ms', kind: 'duration' }] },
  login: { path: '/security-events', title: '登录日志', description: '逐条查看登录成功、失败、拦截、第二因子、退出与会话撤销证据。', fields: [at,
    { key: 'username', label: '账号', column: true, filter: true },
    { key: 'result', label: '结果', kind: 'result', column: true, filter: true, options: resultOptions }, ip,
    { key: 'authMethod', label: '认证方式', column: true, filter: true, options: [['opaque', '账号密码'], ['totp', '验证器验证码'], ['recovery_code', '一次性恢复码'], ['federated', '节点联合登录'], ['session', '现有会话']] },
    { key: 'device', label: '设备', column: true }, { key: 'action', label: '认证事件', filter: true },
    { key: 'reasonCode', label: '原因码', column: true }, request,
    { key: 'accountId', label: '账号 ID' }, { key: 'identifierHash', label: '账号安全摘要' }, { key: 'reason', label: '具体原因' }, { key: 'deviceId', label: '设备 ID' }, { key: 'mfa', label: '第二因子' },
    { key: 'userAgent', label: '用户代理' }, { key: 'actorType', label: '身份类型' }, { key: 'detail', label: '事件上下文', kind: 'json' }] },
  operations: { path: '/audit', title: '操作日志', description: '成功提交与失败尝试共用筛选，追溯操作者、对象、来源及变更内容。', fields: [at,
    { key: 'actor', label: '操作者', column: true, filter: true }, { key: 'role', label: '操作时角色', column: true, options: [['owner', '所有者'], ['admin', '管理员'], ['viewer', '只读运维']] },
    { key: 'target', label: '对象', column: true, filter: true }, { key: 'action', label: '动作', column: true, filter: true, supporting: ['summary'], options: Object.entries(AUDIT_ACTION_LABELS) },
    { key: 'result', label: '结果', column: true, filter: true, kind: 'result', options: [['success', '成功提交'], ['failure', '失败尝试']] }, ip, request,
    { key: 'summary', label: '操作说明' }, { key: 'actorId', label: '操作者 ID' }, { key: 'targetId', label: '对象 ID' }, { key: 'reason', label: '操作原因' },
    { key: 'reasonCode', label: '失败原因码' }, { key: 'message', label: '失败说明' },
    { key: 'before', label: '变更前', kind: 'json' }, { key: 'after', label: '变更后', kind: 'json' }] },
  tasks: { path: '/task-logs', title: '任务日志', description: '检索维护任务的执行、重试和错误证据；任务管理统一进入任务中心。', fields: [
    { key: 'jobName', label: '任务名', column: true, filter: true, supporting: ['jobId'], options: JOB_TYPES.map((job) => [job.value, job.label]) }, { key: 'jobId', label: '任务 ID', filter: true },
    { key: 'startedAt', label: '开始时间', kind: 'time', column: true, supporting: ['finishedAt'] }, { key: 'finishedAt', label: '结束时间', kind: 'time' },
    { key: 'result', label: '状态', kind: 'result', column: true, filter: true, options: taskOptions },
    { key: 'durationMs', label: '耗时 · ms', kind: 'duration', column: true }, { key: 'attempt', label: '尝试次数', column: true },
    { ...instance, column: true }, { ...request, column: false }, { ...at, column: false }, { key: 'createdBy', label: '创建人' }, { key: 'retryOf', label: '重试来源' },
    { key: 'phase', label: '执行阶段' }, { key: 'processed', label: '已处理' }, { key: 'total', label: '总计' },
    { key: 'reasonCode', label: '错误码' }, { key: 'message', label: '错误信息' }, { key: 'outcome', label: '检查结果' },
    { key: 'detail', label: '执行结果', kind: 'json' }, { key: 'events', label: '运行事件（最近 100 条）', kind: 'json' }] },
  containers: { path: '/container-logs', title: '容器日志', description: '只读查询宿主机采集的白名单容器输出，可按时间、流和关键词检索。', fields: [at,
    { key: 'container', label: '容器', column: true, filter: true },
    { key: 'stream', label: '输出流', column: true, filter: true, options: [['stdout', 'stdout'], ['stderr', 'stderr']] },
    { key: 'message', label: '内容', column: true }] },
};

export function categoryForLogPath(path: string): LogCategory | undefined {
  return (Object.keys(LOG_DEFINITIONS) as LogCategory[]).find((category) => LOG_DEFINITIONS[category].path === path);
}

export function logFieldText(field: LogField, value: unknown): string {
  if (value == null || value === '') return '未记录';
  if (typeof value === 'boolean') return value ? '是' : '否';
  const option = field.options?.find(([key]) => key === String(value));
  if (option) return option[1];
  if (field.kind === 'time') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false });
  if (field.kind === 'duration') return Number(value).toFixed(1);
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
