export const SETTING_GROUPS = [
  { id: 'capacity', label: '容量与附件', description: '设置普通账号的默认容量以及单个附件上限。单独设置过配额的账号仍使用其专属值；同步组内每台服务器需分别设置相同策略。' },
  { id: 'backup', label: '备份计划', description: '启用后会在维护窗口内自动短暂停服、备份校验并重启。保存前核对服务器路径和时区；到“存储与备份”查看执行器心跳与结果。' },
  { id: 'notifications', label: '告警通知', description: '需要站外提醒时配置。暂停某条通知不会修复问题；留空表示不向外发送。' },
  { id: 'security', label: '访问安全', description: '调整管理员登录要求。启用两步验证要求前，所有管理员需先在“账号安全”完成绑定。' },
  { id: 'retention', label: '记录保留', description: '根据排查所需的历史跨度调整。缩短保留范围可能在后续清理中删除旧记录。' },
  { id: 'advanced', label: '高级阈值', description: '已有持续误报或明确的资源约束时再调整；通常保持默认值即可。' },
  { id: 'updates', label: '版本更新', description: '检查并安装签名的 0.3.x 补丁版本。' },
  { id: 'sync-group', label: '服务器同步组', description: '在主节点创建同步组，其他服务器各加入一次。组内账号、账本和附件由服务器自动传播。' },
] as const;

export function settingGroup(name: string): string {
  if (name === 'defaultCommitQuotaBytes' || name === 'defaultBlobQuotaBytes' || name === 'attachmentMaxFileBytes') return 'capacity';
  if (name.startsWith('backup')) return 'backup';
  if (name === 'alertChannels' || name === 'alertWebhookUrl') return 'notifications';
  if (name === 'requireAdminMfa' || name === 'ledgerWebAccess' || name === 'adminAccessPath') return 'security';
  if (name.toLowerCase().includes('retention')) return 'retention';
  return 'advanced';
}

/** Preserve drafts in other groups when a save refreshes the effective configuration. */
export function mergeSettingDrafts(draft: Record<string, string>, previous: Record<string, string>, incoming: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(incoming).map(([key, value]) =>
    [key, draft[key] !== undefined && draft[key] !== previous[key] ? draft[key] : value]));
}
