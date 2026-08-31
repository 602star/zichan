import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import type { LedgerMode, Setting } from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import {
  adoptUnlockedLedgerKeyEnvelope,
} from '../ledger-key-vault.js';
import {
  BackupPassphraseRequiredError,
  describePreflight,
  parseEncryptedBackup,
  rehearseRestore,
  type ParsedEncryptedBackup,
} from '../db/backups.js';
import {
  BASE_CURRENCY_CHOICES,
  initializeDemoLedger,
  initializeEmptyLedger,
  initializedLedgerSetting,
  type BaseCurrencyChoice,
} from '../db/ledger-initialization.js';
import { importPortableLedger, preflightPortableBackup } from '../db/portable-backup.js';

type FirstRunChoice = 'empty' | 'import' | 'demo';

export interface FirstRunWizardProps {
  store: SqlLedgerStore;
  onInitialized: (setting: Setting) => Promise<void>;
}

export interface FirstRunFlight {
  active: boolean;
}

/** React state is asynchronous, so first-run writes also need a synchronous gate. */
export function claimFirstRunFlight(flight: FirstRunFlight): boolean {
  if (flight.active) return false;
  flight.active = true;
  return true;
}

export function releaseFirstRunFlight(flight: FirstRunFlight): void {
  flight.active = false;
}

export async function restoreFirstRunBackup(
  store: SqlLedgerStore,
  openedBackup: ParsedEncryptedBackup,
  initializedAt = new Date().toISOString(),
): Promise<Setting> {
  const deviceRestore = openedBackup.payload.kind === 'device' && openedBackup.payload.deviceState
    ? openedBackup.payload.deviceState
    : undefined;
  await importPortableLedger(store, openedBackup.payload.ledger, 'replace', {
    deviceState: deviceRestore,
    initialize: { initializedAt, fallbackLedgerKind: 'personal' },
    // Every encrypted archive carries the ledger key envelope. Adopting it is
    // required for portable-ledger backups too; otherwise the restored ledger
    // opens but cannot create its first automatic backup.
    onDatabaseCommitted: () => {
      adoptUnlockedLedgerKeyEnvelope(openedBackup.container.keyEnvelope, openedBackup.session, true);
    },
  });
  const setting = await initializedLedgerSetting(store);
  if (!setting) throw new Error('备份恢复后缺少初始化标识');
  return setting;
}

const button: CSSProperties = {
  minHeight: 44,
  border: 0,
  borderRadius: 9,
  padding: '0 16px',
  background: '#985734',
  color: '#fff',
  fontWeight: 850,
  cursor: 'pointer',
};

const field: CSSProperties = {
  width: '100%',
  minHeight: 44,
  marginTop: 6,
  border: '1px solid #cfc4b4',
  borderRadius: 8,
  padding: '0 11px',
  boxSizing: 'border-box',
  background: '#fffdf9',
  color: '#4e473f',
};

export function FirstRunWizard({ store, onInitialized }: FirstRunWizardProps) {
  const flight = useRef<FirstRunFlight>({ active: false });
  const [choice, setChoice] = useState<FirstRunChoice>('empty');
  const [baseCurrencyCode, setBaseCurrencyCode] = useState<BaseCurrencyChoice['code']>('CNY');
  const [ledgerMode, setLedgerMode] = useState<LedgerMode>('spending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openedBackup, setOpenedBackup] = useState<ParsedEncryptedBackup | null>(null);
  const [backupSummary, setBackupSummary] = useState('');
  const [lockedFile, setLockedFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');

  async function complete(action: () => Promise<Setting>) {
    if (!claimFirstRunFlight(flight.current)) return;
    setBusy(true);
    setError('');
    try {
      await onInitialized(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      releaseFirstRunFlight(flight.current);
      setBusy(false);
    }
  }

  async function validateBackup(opened: ParsedEncryptedBackup) {
    const preflight = await preflightPortableBackup(opened.payload.ledger);
    if (!preflight.ok) {
      throw new Error(`备份预检失败：${preflight.issues
        .filter((issue) => issue.level === 'error')
        .map((issue) => issue.message)
        .join('；')}`);
    }
    const rehearsal = await rehearseRestore(opened.payload.ledger);
    if (!rehearsal.ok) {
      throw new Error(rehearsal.error || rehearsal.consistencyIssues.map((issue) => issue.detail).join('；') || '恢复演练未通过');
    }
    setOpenedBackup(opened);
    setBackupSummary(describePreflight(preflight));
    setLockedFile(null);
    setPassphrase('');
  }

  async function openBackup(file: File, password?: string) {
    if (!claimFirstRunFlight(flight.current)) return;
    setBusy(true);
    setError('');
    setOpenedBackup(null);
    setBackupSummary('');
    try {
      await validateBackup(await parseEncryptedBackup(file, password));
    } catch (reason) {
      if (reason instanceof BackupPassphraseRequiredError) {
        setLockedFile(file);
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      releaseFirstRunFlight(flight.current);
      setBusy(false);
    }
  }

  function choose(next: FirstRunChoice) {
    if (busy) return;
    setChoice(next);
    setError('');
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await openBackup(file);
  }

  async function restoreSelectedBackup(): Promise<Setting> {
    if (!openedBackup) throw new Error('请先选择并验证 .zcbak 备份');
    return restoreFirstRunBackup(store, openedBackup);
  }

  return (
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(22px, 5vw, 64px)', boxSizing: 'border-box', background: '#f0e9dc', color: '#4e473f', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(920px, 100%)', margin: '0 auto' }}>
        <div style={{ color: '#985734', fontSize: 12, fontWeight: 900, letterSpacing: '.12em' }}>ZICHAN · 首次设置</div>
        <h1 style={{ margin: '10px 0 4px', fontSize: 'clamp(28px, 5vw, 46px)', color: '#672f20' }}>开始你的账本</h1>
        <p style={{ margin: 0, color: '#756b60', lineHeight: 1.7 }}>请选择一种初始化方式。完成后，本机数据密码同时用于加密备份与端到端同步密钥；完成之前不会运行定期任务、维护任务或自动备份。</p>

        <div role="radiogroup" aria-label="账本初始化方式" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 28 }}>
          {([
            ['empty', '创建空账本', '只建立基础币种、设置和系统分类，不写入任何业务流水。'],
            ['import', '导入备份', '预检并演练加密 .zcbak，全部通过后再原子恢复。'],
            ['demo', '体验演示', '显式创建完整演示数据，并持续标记为演示账本。'],
          ] as const).map(([value, title, detail]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={choice === value}
              disabled={busy}
              onClick={() => choose(value)}
              style={{ minHeight: 126, padding: 18, textAlign: 'left', border: choice === value ? '2px solid #985734' : '1px solid #d6ccbd', borderRadius: 12, background: choice === value ? '#fff9f1' : '#fffdf9', color: '#4e473f', cursor: busy ? 'wait' : 'pointer' }}
            >
              <span style={{ display: 'block', fontSize: 17, fontWeight: 900 }}>{title}</span>
              <span style={{ display: 'block', marginTop: 8, color: '#756b60', fontSize: 13, lineHeight: 1.55 }}>{detail}</span>
            </button>
          ))}
        </div>

        <section style={{ marginTop: 18, padding: 'clamp(18px, 4vw, 28px)', border: '1px solid #d6ccbd', borderRadius: 12, background: '#fffdf9', boxShadow: '0 18px 48px rgba(75,61,43,.08)' }}>
          {choice === 'empty' && (
            <form onSubmit={(event) => {
              event.preventDefault();
              void complete(() => initializeEmptyLedger(store, { baseCurrencyCode, ledgerMode }));
            }}>
              <h2 style={{ margin: 0, fontSize: 19 }}>创建空账本</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, marginTop: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 850 }}>
                  基础币种
                  <select value={baseCurrencyCode} onChange={(event) => setBaseCurrencyCode(event.target.value as BaseCurrencyChoice['code'])} style={field}>
                    {BASE_CURRENCY_CHOICES.map((currency) => <option key={currency.code} value={currency.code}>{currency.name}（{currency.code}）</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 12, fontWeight: 850 }}>
                  账本模式
                  <select value={ledgerMode} onChange={(event) => setLedgerMode(event.target.value as LedgerMode)} style={field}>
                    <option value="spending">轻量记账</option>
                    <option value="accounts">账户记账</option>
                    <option value="assets">完整资产账本</option>
                  </select>
                </label>
              </div>
              <button type="submit" aria-label="确认创建空账本" disabled={busy} style={{ ...button, marginTop: 20, opacity: busy ? 0.55 : 1 }}>{busy ? '正在创建…' : '创建空账本'}</button>
            </form>
          )}

          {choice === 'import' && (
            <div>
              <h2 style={{ margin: 0, fontSize: 19 }}>导入加密备份</h2>
              <p style={{ color: '#756b60', fontSize: 13, lineHeight: 1.6 }}>文件会先完成结构预检和独立恢复演练。任何失败都不会写入业务数据。</p>
              <label style={{ display: 'inline-flex', alignItems: 'center', ...button, opacity: busy ? 0.55 : 1 }}>
                {busy ? '正在验证…' : '选择 .zcbak 文件'}
                <input type="file" accept="application/x-zichan-backup,.zcbak" disabled={busy} onChange={(event) => void handleFile(event)} style={{ display: 'none' }} />
              </label>
              {lockedFile && (
                <form onSubmit={(event) => { event.preventDefault(); void openBackup(lockedFile, passphrase); }} style={{ marginTop: 16 }}>
                  <label style={{ display: 'block', maxWidth: 420, fontSize: 12, fontWeight: 850 }}>
                    备份加密密码
                    <input autoFocus type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} style={field} />
                  </label>
                  <button type="submit" disabled={busy || !passphrase} style={{ ...button, marginTop: 12, opacity: busy || !passphrase ? 0.55 : 1 }}>解锁并验证</button>
                </form>
              )}
              {openedBackup && (
                <div role="status" style={{ marginTop: 16, padding: 14, borderRadius: 9, background: '#edf5ec', color: '#355c37', lineHeight: 1.55 }}>
                  <strong>预检与演练通过</strong><br />{backupSummary}
                  <div><button type="button" disabled={busy} onClick={() => void complete(restoreSelectedBackup)} style={{ ...button, marginTop: 12 }}>恢复这个备份</button></div>
                </div>
              )}
            </div>
          )}

          {choice === 'demo' && (
            <div>
              <h2 style={{ margin: 0, fontSize: 19 }}>创建演示账本</h2>
              <p style={{ color: '#756b60', fontSize: 13, lineHeight: 1.6 }}>将写入用于体验功能的模拟资产、流水、定投、游戏和物品数据。它不会被伪装成正式账本。</p>
              <button type="button" disabled={busy} onClick={() => void complete(() => initializeDemoLedger(store))} style={{ ...button, opacity: busy ? 0.55 : 1 }}>{busy ? '正在创建…' : '创建演示账本'}</button>
            </div>
          )}

          <div aria-live="polite" style={{ minHeight: 20, marginTop: 14, color: '#a43f36', fontSize: 13 }}>{error}</div>
        </section>
      </section>
    </main>
  );
}
