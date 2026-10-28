/** Labels mirror the server's closed set of management mutations. Raw codes remain in details. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  role: '调整账号角色',
  state: '变更账号状态',
  'commit-quota': '调整提交配额',
  'blob-quota': '调整附件配额',
  registration: '调整注册策略',
  'revoke-session': '撤销设备会话',
  'invite-create': '创建邀请码',
  'invite-state': '变更邀请码状态',
  'password-reset-issue': '发放密码重置码',
  'password-reset-revoke': '撤销密码重置码',
  'password-reset-complete': '完成密码重置',
  'password-change-authorize': '授权密码变更',
  'owner-recovery-local': '发放本机恢复凭据',
  'settings-save': '保存系统设置',
  'settings-update': '更新系统设置',
  'sessions-revoke-all': '撤销全部会话',
  'alert-acknowledge': '确认告警',
  'alert-silence': '暂停告警通知',
  'alert-unsilence': '恢复告警通知',
  'mfa-enroll': '启用双重验证',
  'mfa-disable': '停用双重验证',
  'mfa-recovery-codes': '重置恢复码',
  'maintenance-on': '开启维护模式',
  'maintenance-off': '结束维护模式',
  'ledger-preview-open': '打开账本预览',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? '未识别操作';
}

export function auditTargetLabel(entry: { targetName: string; targetAccountId: string | null; action: string }): string {
  if (entry.targetName) return entry.targetName;
  if (entry.targetAccountId) return entry.targetAccountId;
  if (entry.action.startsWith('alert-')) return '告警规则';
  if (entry.action.startsWith('invite-')) return '邀请码';
  if (entry.action.startsWith('settings-')) return '系统配置';
  if (entry.action.startsWith('maintenance-')) return '维护模式';
  return '系统';
}
