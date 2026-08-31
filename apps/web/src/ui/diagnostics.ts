/**
 * Copies text from both browser and Tauri WebView contexts. The visible error
 * panels always retain a manual-copy fallback, because a hardened WebView can
 * still reject programmatic clipboard access.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based legacy API below.
    }
  }

  if (typeof document === 'undefined') throw new Error('clipboard unavailable');
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('aria-hidden', 'true');
  Object.assign(textarea.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) {
      throw new Error('clipboard unavailable');
    }
  } finally {
    textarea.remove();
  }
}

export function formatInitializationDiagnostic(message: string, resetRequired: boolean): string {
  const location = typeof window === 'undefined'
    ? 'unknown'
    : `${window.location.origin}${window.location.pathname}`;
  return [
    `时间：${new Date().toISOString()}`,
    `页面：${location}`,
    '错误：数据库初始化失败',
    `详情：${message}`,
    resetRequired ? '恢复建议：旧数据尚未被修改；确认已有 .zcbak 备份或服务器副本后，才可重置本机开发数据。' : '',
  ].filter(Boolean).join('\n');
}
