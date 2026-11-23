/** Stable domains; new pages belong to a domain instead of extending a flat sidebar. */
export const ADMIN_NAVIGATION = [
  { label: '运维中心', pages: [
    { path: '/overview', label: '运行概览' },
    { path: '/requests', label: '访问与请求' },
    { path: '/startup', label: '打开性能' },
    { path: '/monitor', label: '运行监控' },
    { path: '/database', label: '数据库' },
    { path: '/alerts', label: '告警中心' },
  ] },
  { label: '用户与访问', pages: [
    { path: '/users', label: '用户管理' },
    { path: '/sessions', label: '设备与会话' },
    { path: '/invites', label: '注册与邀请', ownerOnly: true },
  ] },
  { label: '数据与备份', pages: [{ path: '/storage', label: '存储与备份' }] },
  { label: '运行与维护', pages: [
    { path: '/sync', label: '同步诊断' },
    { path: '/jobs', label: '任务中心' },
  ] },
  { label: '日志管理', pages: [
    { path: '/logs', label: '日志管理' },
  ] },
  { label: '系统设置', pages: [{ path: '/settings', label: '系统设置' }] },
] satisfies { label: string; pages: { path: string; label: string; ownerOnly?: boolean }[] }[];

export function adminWorkspacePath(path: string) {
  return path === '/traffic' ? '/requests' : ['/host', '/collectors'].includes(path) ? '/monitor' : path;
}

export function adminViewTarget(target: string, view: string, query: URLSearchParams) {
  const next = new URLSearchParams(query);
  if (view) next.set('view', view); else next.delete('view');
  if (target === '/traffic' && next.get('range') === '15m') next.set('range', '1h');
  return `${target}${next.size ? `?${next}` : ''}`;
}

export function adminNavigation(role: string) {
  return ADMIN_NAVIGATION.map((group) => ({
    ...group,
    pages: group.pages.filter((page) => !('ownerOnly' in page && page.ownerOnly) || role === 'owner'),
  }));
}
