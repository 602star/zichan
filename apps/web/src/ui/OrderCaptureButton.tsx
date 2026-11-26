import { lazy, Suspense, useState } from 'react';
import type { OrderCaptureApplication } from '../order-capture/application.js';

const LocalOrderCapture = lazy(() => import('./LocalOrderCapture.js'));
export function OrderCaptureButton({ values, manual, currency, onApply }: {
  values: Record<string, string>; manual: ReadonlySet<string>; currency: string;
  onApply: (application: OrderCaptureApplication) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return <div style={{ marginTop: 10 }}>
    <button type="button" className="zc-btn" onClick={() => setOpen(true)}>从截图识别金额与日期</button>
    <p className="zc-meta">在本机识别，原图不作为附件保存。</p>
    {open && <Suspense fallback={<p role="status" className="zc-meta">正在打开本机识别…</p>}>
      <LocalOrderCapture values={values} manual={manual} currency={currency} onClose={() => setOpen(false)} onApply={async (application) => { await onApply(application); setOpen(false); }} />
    </Suspense>}
  </div>;
}
