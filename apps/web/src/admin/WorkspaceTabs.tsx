export function WorkspaceTabs({ path, query, navigate }: {
  path: string; query: URLSearchParams; navigate: (to: string) => void;
}) {
  const access = path === '/requests' || path === '/traffic' || path === '/startup';
  const views = access ? [
    ['/requests', '', '请求分析', 'API 响应与路由'], ['/traffic', '', '访问分析', '页面、访客与地区'],
    ['/startup', '', '打开性能', '首开、缓存与后台追平'],
  ] : [
    ['/monitor', 'application', '应用自身', 'Node 进程与事件循环'],
    ['/monitor', 'system', '系统资源', '主机或容器可见范围'],
    ['/monitor', 'metrics', '指标目录', '按指标查趋势与导出'],
    ['/host', '', '主机与容器', '独立探活与容器状态'],
    ['/collectors', '', '采集任务', '采集器心跳与健康'],
  ];
  return <nav className="zc-admin-workspace-nav zc-admin-workspace-tabs" aria-label={access ? '访问与请求视图' : '运行监控视图'}>{views.map(([target, view, label, note]) => {
    const active = target === path && (!view || view === (query.get('view') || 'application'));
    return <button type="button" key={`${target}-${view}`} aria-current={active ? 'page' : undefined} onClick={() => {
      navigate(adminViewTarget(target!, view!, query));
    }}><strong>{label}</strong><span>{note}</span></button>;
  })}</nav>;
}
import { adminViewTarget } from './navigation.js';
