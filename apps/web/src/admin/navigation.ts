/** Stable domains; new pages belong to a domain instead of extending a flat sidebar. */
export const ADMIN_NAVIGATION = [
  { label: '总览', pages: [{ path: '/overview', label: '运行概览' }] },
  { label: '用户与访问', pages: [
    { path: '/users', label: '用户管理' },
    { path: '/sessions', label: '设备与会话' },
    { path: '/invites', label: '注册与邀请', ownerOnly: true },
  ] },
  { label: '数据与备份', pages: [{ path: '/storage', label: '存储与备份' }] },
  { label: '运行与维护', pages: [
    { path: '/sync', label: '同步诊断' },
    { path: '/resources', label: '进程与数据库' },
    { path: '/jobs', label: '任务中心' },
  ] },
  { label: '事件与记录', pages: [
    { path: '/alerts', label: '告警历史' },
    { path: '/logs', label: '运行日志' },
    { path: '/audit', label: '管理审计' },
    { path: '/security-events', label: '登录安全' },
  ] },
  { label: '系统设置', pages: [{ path: '/settings', label: '系统设置' }] },
] satisfies { label: string; pages: { path: string; label: string; ownerOnly?: boolean }[] }[];

export function adminNavigation(role: string) {
  return ADMIN_NAVIGATION.map((group) => ({
    ...group,
    pages: group.pages.filter((page) => !('ownerOnly' in page && page.ownerOnly) || role === 'owner'),
  }));
}
