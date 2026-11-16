import type { MouseEvent } from 'react';
import { adminBasePath, adminHref } from './router.js';

type LogView = 'logs' | 'audit' | 'security-events' | 'access-logs' | 'task-logs' | 'container-logs';

/** One workspace owns six log modes; the sidebar only links to the workspace once. */
export function LogWorkspaceNav({ current, query, navigate }: {
  current: LogView;
  query?: URLSearchParams;
  navigate?: (to: string) => void;
}) {
  const windowQuery = new URLSearchParams();
  for (const key of ['from', 'until', 'range', 'requestId']) {
    const value = query?.get(key);
    if (value) windowQuery.set(key, value);
  }
  const basePath = typeof window === 'undefined' ? '' : adminBasePath(window.location);
  const items: { path: LogView; label: string; description: string }[] = [
    { path: 'logs', label: '系统日志', description: '组件、消息与堆栈' },
    { path: 'access-logs', label: '访问日志', description: 'HTTP 状态与耗时' },
    { path: 'security-events', label: '登录日志', description: '认证明细与安全汇总' },
    { path: 'audit', label: '操作日志', description: '成功提交与失败尝试' },
    { path: 'task-logs', label: '任务日志', description: '执行、重试与结果' },
    { path: 'container-logs', label: '容器日志', description: '白名单容器输出' },
  ];
  const onClick = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (!navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(path);
  };

  return <nav className="zc-admin-workspace-nav zc-admin-log-nav" aria-label="日志与审计视图">
    {items.map((item) => {
      const path = `/${item.path}${windowQuery.size ? `?${windowQuery}` : ''}`;
      return <a key={item.path} href={adminHref(basePath, path)} aria-current={current === item.path ? 'page' : undefined}
        onClick={(event) => onClick(event, path)}>
        <strong>{item.label}</strong><span>{item.description}</span>
      </a>;
    })}
  </nav>;
}
