/** Historical URLs resolve to one primary page, never a second implementation. */
export function canonicalAdminRoute(path: string, query: URLSearchParams): string | undefined {
  const next = new URLSearchParams(query);
  if (path === '/resources') return `/database${next.size ? `?${next}` : ''}`;
  if (path !== '/monitor') return;
  const view = next.get('view');
  if (view === 'traffic' || view === 'overview') {
    next.delete('view');
    return `${view === 'traffic' ? '/traffic' : '/requests'}${next.size ? `?${next}` : ''}`;
  }
  if (view === 'service' || view === 'resources') {
    next.set('view', view === 'service' ? 'application' : 'system');
    return `/monitor?${next}`;
  }
}
