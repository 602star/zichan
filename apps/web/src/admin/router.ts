/**
 * Minimal path router for the management console.
 *
 * Every page has a real URL under `/admin/...`, so refresh, back/forward and shared
 * links keep the current view and its filters. The server already falls back to
 * `index.html` for extension-less paths, so no server change is needed and no routing
 * dependency is added to the offline-capable Web bundle.
 */
import { useEffect, useState } from 'react';

const NAVIGATE_EVENT = 'zichan:admin:navigate';

export interface AdminRoute {
  /** Path relative to the admin base, always starting with `/`. */
  path: string;
  segments: string[];
  query: URLSearchParams;
  search: string;
}

export function parseAdminPath(pathname: string): string {
  const match = /^(.*)\/admin(?:\/(.*))?$/.exec(pathname);
  if (!match) return '/overview';
  const rest = (match[2] ?? '').replace(/\/+$/, '');
  return rest ? `/${rest}` : '/overview';
}

export function readRoute(): AdminRoute {
  if (typeof window === 'undefined') return { path: '/overview', segments: [], query: new URLSearchParams(), search: '' };
  const path = parseAdminPath(window.location.pathname);
  const search = window.location.search;
  return { path, segments: path.split('/').filter(Boolean), query: new URLSearchParams(search), search };
}

export function useRoute(): AdminRoute {
  const [route, setRoute] = useState<AdminRoute>(readRoute);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return route;
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const url = new URL(to, window.location.origin);
  const current = `${window.location.pathname}${window.location.search}`;
  if (`${url.pathname}${url.search}` === current) return;
  if (options.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/** Builds an admin URL from the deployment base path, e.g. `/ledger/admin/overview`. */
export function adminHref(basePath: string, path: string, query?: Record<string, string | undefined>): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== '') params.set(key, value);
  const search = params.toString();
  return `${basePath}/admin${normalized}${search ? `?${search}` : ''}`;
}

export function adminBasePath(location: Pick<Location, 'pathname'>): string {
  const match = /^(.*)\/admin(?:\/.*)?$/.exec(location.pathname);
  return match ? match[1] ?? '' : '';
}
