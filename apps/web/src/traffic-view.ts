/** Anonymous, browser-scoped traffic telemetry for the hosted web interface. */
let lastPath = '';
let lastSentAt = 0;

function newVisitorId(): string {
  if (window.crypto.randomUUID) return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function reportPageView(baseUrl: string, page: string): void {
  if (typeof window === 'undefined' || !window.crypto?.getRandomValues) return;
  // StrictMode remounts effects in development. A quick duplicate is not a second view.
  if (page === lastPath && Date.now() - lastSentAt < 1000) return;
  lastPath = page;
  lastSentAt = Date.now();
  let visitorId: string;
  try {
    const stored = window.localStorage.getItem('zichan:traffic-visitor');
    visitorId = stored && /^[a-f0-9-]{36}$/.test(stored) ? stored : newVisitorId();
    window.localStorage.setItem('zichan:traffic-visitor', visitorId);
  } catch {
    // Disabled storage still allows PV, with a new browser identifier each load.
    visitorId = newVisitorId();
  }
  void fetch(`${baseUrl}/api/traffic/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId, page }),
    keepalive: true,
  }).catch(() => undefined);
}
