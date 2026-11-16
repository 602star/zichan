type JsonRecord = Record<string, unknown>;

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${Number(amount.toFixed(unit === 0 ? 0 : 1))} ${units[unit]}`;
}

function dateOnly(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
}

/** Human-readable sentence first; raw fields stay available in the detail view. */
export function describeAudit(
  entry: { action: string; before: unknown; after: unknown; reason?: string | null },
  actor: string,
  target: string,
): string {
  const before = (entry.before ?? {}) as JsonRecord;
  const after = (entry.after ?? {}) as JsonRecord;
  const roleName = (role: unknown) => role === 'owner' ? '所有者' : role === 'admin' ? '管理员' : role === 'viewer' ? '只读运维' : '普通用户';
  const reason = typeof entry.reason === 'string' && entry.reason.trim() ? ` 原因：${entry.reason.trim()}。` : '';
  const prefix = target && target !== actor ? `管理员 ${actor} 将用户 ${target}` : `管理员 ${actor}`;
  switch (entry.action) {
    case 'role':
      return `${prefix} 的角色从 ${roleName(before['role'])} 调整为 ${roleName(after['role'])}，并撤销了该账号的现有会话。${reason}`;
    case 'state':
      return `${prefix}的账号状态改为${after['disabled'] ? '已禁用（同时撤销全部会话）' : '正常'}。${reason}`;
    case 'commit-quota':
      return `${prefix}的提交配额调整为 ${after['bytes'] === null ? '服务器默认值' : bytes(Number(after['bytes']))}。${reason}`;
    case 'blob-quota':
      return `${prefix}的附件配额调整为 ${after['bytes'] === null ? '服务器默认值' : bytes(Number(after['bytes']))}。${reason}`;
    case 'revoke-session':
      return `${prefix}的一个设备会话被撤销。${reason}`;
    case 'sessions-revoke-all':
      return `${prefix}的全部可管理会话被撤销（${String(after['revoked'] ?? 0)} 个）。${reason}`;
    case 'registration':
      return `管理员 ${actor} 将注册策略从 ${String(before['value'] ?? before['mode'] ?? '未知')} 改为 ${String(after['mode'])}。${reason}`;
    case 'invite-create':
      return `管理员 ${actor} 创建了一个单次邀请码（有效期至 ${after['expiresAt'] ? dateOnly(String(after['expiresAt'])) : '未设置'}）。${reason}`;
    case 'invite-state':
      return `管理员 ${actor} 将一个邀请码${after['disabled'] ? '撤销' : '重新启用'}。${reason}`;
    case 'password-reset-issue':
      return `${prefix}发放了一次性密码重置码（有效期至 ${after['expiresAt'] ? dateOnly(String(after['expiresAt'])) : '未记录'}）。${reason}`;
    case 'password-reset-revoke':
      return `${prefix}撤销了未使用的密码重置码。${reason}`;
    case 'password-reset-complete':
      return `${target || actor} 完成了账号密码重置，旧会话已撤销。${reason}`;
    case 'password-change-authorize':
      return `${actor} 授权了本人账号的密码变更。${reason}`;
    case 'owner-recovery-local':
      return `部署侧为本机所有者发放了恢复凭据。${reason}`;
    case 'settings-save':
    case 'settings-update':
      return `管理员 ${actor} 修改了系统设置：${Object.keys(after).join('、') || '无变化'}。${reason}`;
    case 'alert-acknowledge':
      return `管理员 ${actor} 确认了告警 ${String(after['key'] ?? '')}。${reason}`;
    case 'alert-silence':
      return `管理员 ${actor} 将告警 ${String(after['key'] ?? '')} 静默 ${String(after['hours'] ?? '')} 小时（至 ${after['silencedUntil'] ? dateOnly(String(after['silencedUntil'])) : '未记录'}），期间不发送外部通知。${reason}`;
    case 'alert-unsilence':
      return `管理员 ${actor} 取消了对告警 ${String(after['key'] ?? '')} 的静默。${reason}`;
    case 'ledger-preview-open':
      // Reading a decrypted ledger leaves no state behind, so the sentence reports the act
      // rather than a change.
      return `管理员 ${actor} 查看了用户 ${target} 的记账数据（预览 ${String(after['previewId'] ?? '')}）。${reason}`;
    case 'maintenance-on':
      return `管理员 ${actor} 声明进入维护模式${after['until'] ? `（计划至 ${dateOnly(String(after['until']))}）` : '（未设结束时间）'}，客户端写入被拒绝，读取保持可用。${reason}`;
    case 'maintenance-off':
      return `管理员 ${actor} 结束维护模式，客户端写入恢复。${reason}`;
    default:
      return `管理员 ${actor} 执行了 ${entry.action}。${reason}`;
  }
}
