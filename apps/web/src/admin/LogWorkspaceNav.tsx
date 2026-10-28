import type { MouseEvent } from 'react';
import { adminBasePath, adminHref } from './router.js';

type LogView = 'logs' | 'audit' | 'security-events';

/** The three records answer different questions but share one investigation path. */
export function LogWorkspaceNav({ current, query, navigate }: {
  current: LogView;
  query?: URLSearchParams;
  navigate?: (to: string) => void;
}) {
  const windowQuery = new URLSearchParams();
  for (const key of ['from', 'until']) {
    const value = query?.get(key);
    if (value) windowQuery.set(key, value);
  }
  const basePath = typeof window === 'undefined' ? '' : adminBasePath(window.location);
  const items: { path: LogView; label: string; description: string }[] = [
    { path: 'logs', label: '运行日志', description: '事件与请求线索' },
    { path: 'audit', label: '管理审计', description: '已提交的管理变更' },
    { path: 'security-events', label: '登录安全', description: '失败来源与限流' },
  ];
  const onClick = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (!navigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(path);
  };

  return <nav className="zc-admin-workspace-nav" aria-label="日志与审计视图">
    {items.map((item) => {
      const path = `/${item.path}${windowQuery.size ? `?${windowQuery}` : ''}`;
      return <a key={item.path} href={adminHref(basePath, path)} aria-current={current === item.path ? 'page' : undefined}
        onClick={(event) => onClick(event, path)}>
        <strong>{item.label}</strong><span>{item.description}</span>
      </a>;
    })}
  </nav>;
}
