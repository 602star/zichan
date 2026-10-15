import type { LogEntry } from './types.js';

type LogAction = { title: string; description: string; group: string };

/** Display text only. API filters and exports continue to use the original action codes. */
const ACTIONS: Record<string, LogAction> = {};
function group(name: string, entries: Record<string, [string, string]>): void {
  for (const [code, [title, description]] of Object.entries(entries)) ACTIONS[code] = { title, description, group: name };
}

group('登录与账号', {
  login_success: ['登录成功', '账号已登录。'], login_failed: ['登录失败', '账号登录未通过。'],
  login_disabled: ['停用账号尝试登录', '已停用的账号尝试登录。'],
  login_mfa_challenge: ['等待二次验证', '密码已通过，正在等待二次验证。'],
  login_mfa_success: ['二次验证通过', '登录的二次验证已通过。'],
  login_mfa_failed: ['二次验证失败', '登录的二次验证未通过。'],
  login_mfa_enrollment_required: ['需要启用二次验证', '管理员尚未启用二次验证，登录被拒绝。'],
  federated_login_success: ['联合登录成功', '已通过联合身份建立本节点会话。'],
  logout: ['退出登录', '账号已退出当前会话。'], refresh_failed: ['会话续期失败', '会话续期未通过，需要重新登录。'],
  register_success: ['注册成功', '新账号已注册。'], admin_forbidden: ['管理访问被拒绝', '普通成员尝试访问管理接口。'],
  account_email_verification_sent: ['验证邮件已发送', '已发送账号邮箱验证邮件。'],
  account_email_verification_send_failed: ['验证邮件发送失败', '账号邮箱验证邮件未能发出。'],
  account_email_verified: ['邮箱验证完成', '账号邮箱已验证。'], account_email_removed: ['邮箱已移除', '账号邮箱已移除。'],
  account_email_delivery_failed: ['账号邮件发送失败', '账号邮件未能送达。'],
  account_email_worker_failed: ['邮件处理失败', '账号邮件处理任务失败。'],
  account_quota_email_queue_failed: ['额度邮件排队失败', '账号额度提醒邮件未能加入队列。'],
  password_reset_email_failed: ['重置邮件发送失败', '密码重置邮件未能发出。'],
  password_reset_revoked: ['重置码已撤销', '未使用的密码重置码已撤销。'],
  user_disabled: ['账号已停用', '同步账号已停用。'], user_enabled: ['账号已启用', '同步账号已启用。'],
  sessions_revoked: ['会话已撤销', '账号的可管理会话已撤销。'], device_revoked: ['设备会话已撤销', '同步设备的会话已撤销。'],
  mfa_enroll_started: ['开始启用二次验证', '管理员开始设置二次验证。'],
  mfa_enroll_failed: ['二次验证设置失败', '二次验证确认未通过。'],
  mfa_enrolled: ['二次验证已启用', '管理员已启用二次验证。'],
  mfa_disabled: ['二次验证已关闭', '管理员已关闭二次验证。'],
  mfa_disable_failed: ['关闭二次验证失败', '关闭二次验证的请求被拒绝。'],
  mfa_recovery_regenerated: ['恢复码已更新', '二次验证恢复码已重新生成。'],
  mfa_recovery_regenerate_failed: ['更新恢复码失败', '重新生成恢复码的请求被拒绝。'],
});

group('同步与数据', {
  commits_pushed: ['加密记录已接收', '服务端已接收加密记录。'],
  blob_upload_started: ['附件上传已开始', '加密附件开始上传。'],
  blob_deduplicated: ['附件无需重复上传', '服务端已有相同的加密附件。'],
  blob_upload_completed: ['附件上传完成', '加密附件已上传完成。'],
  blob_request_failed: ['附件请求失败', '加密附件请求未能完成。'],
  backup_uploaded: ['备份已登记', '加密备份文件已登记。'], backup_deleted: ['备份已删除', '备份记录已删除。'],
  key_envelope_updated: ['密钥封装已更新', '账本密钥封装已更新。'],
  ledger_protection_updated: ['账本保护已更新', '账本保护设置已更新。'],
  replica_bound: ['副本已绑定', '设备副本已绑定到账本。'],
  replica_replaced: ['副本已替换', '设备副本已替换。'],
  replica_restored: ['副本已恢复', '设备副本已恢复。'],
  replica_group_member_retired: ['副本成员已退出', '账本副本组成员已退出。'],
  node_replica_provisioned: ['节点副本已创建', '已创建节点副本。'],
  node_replication_granted: ['节点复制已授权', '节点间复制已获得授权。'],
  node_replication_linked: ['节点复制已连接', '节点间复制连接已建立。'],
  node_replication_rescan_requested: ['节点复制重新扫描', '已请求重新扫描节点复制数据。'],
  node_replication_revoked: ['节点复制已撤销', '节点间复制授权已撤销。'],
  node_grant_rate_limited: ['节点授权请求过快', '节点授权请求触发频率限制。'],
});

group('管理操作', {
  settings_updated: ['运行设置已更新', '运行设置已更改。'],
  maintenance_enabled: ['维护模式已开启', '服务已进入维护模式。'],
  maintenance_disabled: ['维护模式已关闭', '服务已退出维护模式。'],
  maintenance_write_refused: ['维护期间写入被拒绝', '维护期间的客户端写入请求被拒绝。'],
  job_created: ['维护任务已创建', '维护任务已加入队列。'],
  job_cancel_requested: ['已请求取消任务', '已请求取消维护任务。'],
  job_execution_failed: ['维护任务执行失败', '维护任务执行失败。'],
  job_abandoned: ['维护任务已中断', '维护任务未能完成。'],
  jobs_interrupted: ['维护任务恢复处理', '服务启动时处理了中断的维护任务。'],
  startup_tasks_failed: ['启动恢复失败', '服务启动时的恢复任务失败。'],
  housekeeping_completed: ['例行清理完成', '例行清理任务已完成。'],
  housekeeping_failed: ['例行清理失败', '例行清理任务失败。'],
  blob_cleanup: ['附件清理结果', '附件清理任务已记录执行结果。'],
  blob_quota_changed: ['附件额度已更改', '账号的附件额度已更改。'],
  commit_quota_changed: ['同步额度已更改', '账号的加密记录额度已更改。'],
  invite_created: ['邀请码已创建', '已创建注册邀请码。'],
  invite_disabled: ['邀请码已停用', '注册邀请码已停用。'],
  invite_enabled: ['邀请码已启用', '注册邀请码已启用。'],
  registration_mode_changed: ['注册方式已更改', '账号注册方式已更改。'],
  alert_acknowledged: ['告警已确认', '管理员已确认告警。'],
  alert_silenced: ['告警已静音', '管理员已暂时静音告警。'],
  alert_unsilenced: ['告警静音已解除', '管理员已解除告警静音。'],
  audit_exported: ['管理审计已导出', '管理员已导出管理审计记录。'],
  logs_exported: ['运行日志已导出', '管理员已导出运行日志。'],
  ledger_preview_opened: ['账本预览已打开', '管理员已打开账本预览。'],
  ledger_preview_attachment_read: ['预览附件已下载', '管理员下载了账本预览中的附件。'],
  ledger_preview_closed: ['账本预览已关闭', '管理员已关闭账本预览。'],
});

group('服务状态', {
  rate_limited: ['请求过于频繁', '接口请求触发频率限制。'],
  request_failed: ['服务请求失败', '服务请求未能完成。'],
  metrics_sample_failed: ['指标采集失败', '服务指标采集失败。'],
  system_sample_failed: ['系统采集失败', '系统状态采集失败。'],
});

export function logActionTitle(action: string): string { return ACTIONS[action]?.title ?? action; }
export function logActionGroup(action: string): string { return ACTIONS[action]?.group ?? '其他事件'; }
export function logActionOption(action: string): string {
  const title = ACTIONS[action]?.title;
  return title ? `${title} · ${action}` : action;
}
export function logLevelLabel(level: string): string {
  return ({ info: '普通记录', warn: '需关注', error: '错误' } as Record<string, string>)[level] ?? level;
}
export function logRequestId(entry: LogEntry): string {
  return typeof entry.detail?.['requestId'] === 'string' ? entry.detail['requestId'] : '';
}

export function logSummary(entry: LogEntry): string {
  if (entry.action === 'commits_pushed' && typeof entry.detail?.['count'] === 'number') {
    return `服务端已接收 ${entry.detail['count']} 条加密记录。`;
  }
  if (entry.action === 'blob_upload_completed' && typeof entry.detail?.['chunks'] === 'number') {
    return `加密附件已上传完成，共 ${entry.detail['chunks']} 个分块。`;
  }
  if ((entry.action === 'request_failed' || entry.action === 'blob_request_failed') &&
    typeof entry.detail?.['method'] === 'string' && typeof entry.detail?.['path'] === 'string') {
    return `${entry.detail['method']} ${entry.detail['path']} 请求未能完成${entry.status ? `（HTTP ${entry.status}）` : ''}。`;
  }
  return ACTIONS[entry.action]?.description ?? '此事件尚无中文说明，可展开查看原始日志。';
}

const DETAIL_LABELS: Record<string, string> = {
  requestId: '请求 ID', jobId: '任务 ID', ledgerId: '账本 ID', previousLedgerId: '原账本 ID',
  deviceId: '设备 ID', sessionId: '会话 ID', replicaId: '副本 ID', nodeId: '节点 ID',
  peerNodeId: '对端节点 ID', issuerNodeId: '签发节点 ID', linkId: '连接 ID', grantId: '授权 ID',
  archiveId: '备份 ID', checkpointId: '检查点 ID', previewId: '预览 ID',
  count: '数量', chunks: '分块数', bytes: '字节数', rows: '记录条数', transactions: '交易笔数',
  generation: '版本代数', revokedSessions: '撤销的会话数', revoked: '撤销数量', type: '类型',
  reason: '原因', error: '错误原因', code: '错误代码', method: '请求或验证方式', path: '请求路径',
  status: '状态', mode: '模式', key: '告警标识', hours: '小时数', until: '结束时间',
  keys: '变更字段', changedBy: '操作人', by: '操作人', username: '账号', targetUsername: '目标账号',
  quotaBytes: '附件额度（字节）', commitQuotaBytes: '同步额度（字节）',
  format: '导出格式', redacted: '已脱敏', level: '级别', action: '事件代码', note: '备注',
};
export function logDetailLabel(key: string): string { return DETAIL_LABELS[key] ?? key; }
export function logDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(logDetailValue).join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
