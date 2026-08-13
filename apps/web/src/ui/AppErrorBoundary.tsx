import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorState {
  error: Error | null;
  componentStack: string;
  copyStatus: 'idle' | 'copied' | 'failed';
}

export function formatAppDiagnostic(error: Error, componentStack = ''): string {
  const location = typeof window === 'undefined'
    ? 'unknown'
    : `${window.location.origin}${window.location.pathname}`;
  const userAgent = typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;
  let screen = 'unknown';
  try {
    screen = sessionStorage.getItem('zichan.activeScreen') ?? 'unknown';
  } catch {
    // Session storage can be unavailable in hardened browser contexts.
  }
  return [
    `时间：${new Date().toISOString()}`,
    `页面：${location}`,
    `环境：${userAgent}`,
    `功能：${screen}`,
    `错误：${error.name}: ${error.message}`,
    error.stack ? `堆栈：\n${error.stack}` : '',
    componentStack ? `组件：${componentStack}` : '',
  ].filter(Boolean).join('\n');
}

async function copyDiagnostic(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('clipboard unavailable');
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorState> {
  override state: ErrorState = { error: null, componentStack: '', copyStatus: 'idle' };

  static getDerivedStateFromError(error: unknown): Partial<ErrorState> {
    return { error: error instanceof Error ? error : new Error(String(error)), copyStatus: 'idle' };
  }

  override componentDidCatch(_error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  private returnToDashboard = () => {
    try {
      sessionStorage.setItem('zichan.activeScreen', 'dashboard');
    } catch {
      // Session storage can be unavailable in hardened browser contexts.
    }
    this.setState({ error: null, componentStack: '', copyStatus: 'idle' }, () => {
      window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'dashboard' } }));
    });
  };

  private retryCurrentPage = () => {
    try {
      const screen = sessionStorage.getItem('zichan.activeScreen');
      if (screen) sessionStorage.setItem('zichan.retryScreen', screen);
    } catch {
      // Session storage can be unavailable in hardened browser contexts.
    }
    window.location.reload();
  };

  private copy = async () => {
    const { error, componentStack } = this.state;
    if (!error) return;
    try {
      await copyDiagnostic(formatAppDiagnostic(error, componentStack));
      this.setState({ copyStatus: 'copied' });
    } catch {
      this.setState({ copyStatus: 'failed' });
    }
  };

  override render() {
    const { error, copyStatus } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="zc-error-boundary" role="alert">
        <div className="zc-error-boundary-card">
          <div className="zc-error-boundary-kicker">页面恢复</div>
          <h1>这个页面暂时无法显示</h1>
          <p>账本数据库没有被重置。你可以重试当前页面，或返回总览继续使用其他功能。</p>
          <details>
            <summary>查看错误摘要</summary>
            <code>{error.name}: {error.message}</code>
          </details>
          <div className="zc-error-boundary-actions">
            <button type="button" onClick={this.retryCurrentPage}>重试当前页面</button>
            <button type="button" onClick={this.returnToDashboard}>返回总览</button>
            <button type="button" onClick={() => void this.copy()}>复制诊断信息</button>
          </div>
          {copyStatus !== 'idle' && (
            <div role="status">{copyStatus === 'copied' ? '诊断信息已复制' : '复制失败，请展开错误摘要后手动复制'}</div>
          )}
        </div>
      </main>
    );
  }
}
