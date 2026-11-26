import { useState } from 'react';
import { readRestoreEntryDraft, writeRestoreEntryDraft } from '../draft-preferences.js';
export function DraftSettings() {
  const [restore, setRestore] = useState(readRestoreEntryDraft), [error, setError] = useState('');
  return <section className="zc-card" aria-label="记账草稿设置"><h2 className="zc-section-title">记账草稿</h2><label className="zc-label"><input type="checkbox" checked={restore} onChange={(event) => {
    try { writeRestoreEntryDraft(event.target.checked); setRestore(event.target.checked); setError(''); }
    catch { setError('无法保存本机偏好，请重试。'); }
  }} />新建记账时自动恢复最近草稿</label><p className="zc-caption">默认关闭，每次打开空白新记录。旧草稿保留在草稿列表中，可手动恢复，不影响选择附件；此设置仅保存在本机。</p>{error && <p role="alert">{error}</p>}</section>;
}
