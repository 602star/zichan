import { accountSessionStorage } from '../account-storage.js';
import { accountProtection } from '../account-protection.js';
import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import type { Setting } from '@zichan/core';
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
import { btnOutline } from './styles.js';

type FirstRunChoice = 'advanced' | 'import' | 'demo' | null;

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

function rememberQuickExpenseStart(): void {
  try {
    accountSessionStorage.setItem('zichan.postFirstRun', 'quick-expense');
  } catch {
    // Session storage is only a navigation hint; ledger creation must still succeed without it.
  }
}

export async function restoreFirstRunBackup(
  store: SqlLedgerStore,
  openedBackup: ParsedEncryptedBackup,
  initializedAt = new Date().toISOString(),
): Promise<Setting> {
  const deviceRestore = !accountProtection() && openedBackup.payload.kind === 'device' && openedBackup.payload.deviceState
    ? openedBackup.payload.deviceState
    : undefined;
  await importPortableLedger(store, openedBackup.payload.ledger, 'replace', {
    deviceState: deviceRestore,
    initialize: { initializedAt, fallbackLedgerKind: 'personal' },
    // Every encrypted archive carries the ledger key envelope. Adopting it is
    // required for portable-ledger backups too; otherwise the restored ledger
    // opens but cannot create its first automatic backup.
    onDatabaseCommitted: () => {
      if (!accountProtection()) adoptUnlockedLedgerKeyEnvelope(openedBackup.container.keyEnvelope, openedBackup.session, true);
    },
  });
  const setting = await initializedLedgerSetting(store);
  if (!setting) throw new Error('备份恢复后缺少初始化标识');
  return setting;
}

const button = btnOutline;

const field: CSSProperties = {
  width: '100%',
  minHeight: 44,
  marginTop: 6,
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--r-sm)',
  padding: '0 11px',
  boxSizing: 'border-box',
  background: 'var(--surface)',
  color: 'var(--text-primary)',
};

export function FirstRunWizard({ store, onInitialized }: FirstRunWizardProps) {
  const flight = useRef<FirstRunFlight>({ active: false });
  const [choice, setChoice] = useState<FirstRunChoice>(null);
  const [baseCurrencyCode, setBaseCurrencyCode] = useState<BaseCurrencyChoice['code']>('CNY');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openedBackup, setOpenedBackup] = useState<ParsedEncryptedBackup | null>(null);
  const [backupSummary, setBackupSummary] = useState('');
  const [lockedFile, setLockedFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');

  async function complete(action: () => Promise<Setting>, afterCreate?: () => void) {
    if (!claimFirstRunFlight(flight.current)) return;
    setBusy(true);
    setError('');
    try {
      const setting = await action();
      afterCreate?.();
      await onInitialized(setting);
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
    <main style={{ minHeight: '100dvh', overflowY: 'auto', padding: 'clamp(22px, 5vw, 64px)', boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: 'system-ui, sans-serif' }}>
      <section style={{ width: 'min(920px, 100%)', margin: '0 auto' }}>
        <div style={{ color: 'var(--accent)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', letterSpacing: '.12em' }}>ZICHAN · 首次设置</div>
        <h1 className="zc-first-run-title" style={{ margin: '10px 0' }}>你希望怎样开始记账？</h1>
        <p>先决定要不要分开记录银行卡、微信和支付宝。以后随时可以添加账户。</p>
        <label>记账币种 <select aria-label="记账币种" value={baseCurrencyCode} onChange={(e) => setBaseCurrencyCode(e.target.value as BaseCurrencyChoice['code'])} style={field}>{BASE_CURRENCY_CHOICES.map((c) => <option key={c.code} value={c.code}>{c.name}（{c.code}）</option>)}</select></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18, marginTop: 24 }}>
          <section style={{ padding: 24, background: 'var(--surface-2)', border: '2px solid var(--accent)', borderRadius: 'var(--r-md)' }}>
            <h2>先记收支</h2><p>看赚了多少、花在哪里。系统准备好收入和支出账户，你直接记金额和分类。</p><p className="zc-meta">不确定就先选这个。</p>
            <button disabled={busy} style={button} onClick={() => void complete(() => initializeEmptyLedger(store, { baseCurrencyCode, ledgerMode: 'spending' }), rememberQuickExpenseStart)}>{busy ? '正在创建…' : '开始记账'}</button>
          </section>
          <section style={{ padding: 24, background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)' }}>
            <h2>分账户记账</h2><p>还想知道每张卡、每个钱包剩多少钱。添加账户和当前余额，记账时选择收付款账户，之后可以转账和核对账单。</p>
            <button disabled={busy} style={button} onClick={() => void complete(() => initializeEmptyLedger(store, { baseCurrencyCode, ledgerMode: 'accounts' }), () => accountSessionStorage.setItem('zichan.postFirstRun', 'account-setup'))}>{busy ? '正在创建…' : '添加常用账户'}</button>
          </section>
        </div>
        <p style={{ marginTop: 16 }}>两种方式都能使用全部功能；这个选择只影响开始时的设置。</p>

        <div style={{ marginTop: 22 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>其他方式</div>
          <div aria-label="其他账本初始化方式" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
            {([
              ['import', '导入备份'],
              ['demo', '体验演示'],
            ] as const).map(([value, title]) => (
              <button
                key={value}
                type="button"
                aria-pressed={choice === value}
                disabled={busy}
                onClick={() => choose(value)}
                style={{ minHeight: 40, padding: '0 14px', border: choice === value ? '2px solid var(--accent)' : '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', background: choice === value ? 'var(--surface-2)' : 'var(--surface)', color: 'var(--text-primary)', fontWeight: 'var(--fw-bold)', cursor: busy ? 'wait' : 'pointer' }}
              >
                {title}
              </button>
            ))}
          </div>
        </div>

        {choice && (
          <section style={{ marginTop: 18, padding: 'clamp(18px, 4vw, 28px)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface)', boxShadow: 'var(--shadow-lg)' }}>
          {choice === 'import' && (
            <div>
              <h2 style={{ margin: 0, fontSize: 'var(--fs-heading)' }}>导入加密备份</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 1.6 }}>文件会先完成结构预检和独立恢复演练。任何失败都不会写入业务数据。</p>
              <label style={{ display: 'inline-flex', alignItems: 'center', ...button, opacity: busy ? 0.55 : 1 }}>
                {busy ? '正在验证…' : '选择 .zcbak 文件'}
                <input type="file" accept="application/x-zichan-backup,.zcbak" disabled={busy} onChange={(event) => void handleFile(event)} style={{ display: 'none' }} />
              </label>
              {lockedFile && (
                <form onSubmit={(event) => { event.preventDefault(); void openBackup(lockedFile, passphrase); }} style={{ marginTop: 16 }}>
                  <label style={{ display: 'block', maxWidth: 420, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>
                    备份加密密码
                    <input autoFocus type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} style={field} />
                  </label>
                  <button type="submit" disabled={busy || !passphrase} style={{ ...button, marginTop: 12, opacity: busy || !passphrase ? 0.55 : 1 }}>解锁并验证</button>
                </form>
              )}
              {openedBackup && (
                <div role="status" style={{ marginTop: 16, padding: 14, borderRadius: 'var(--r-sm)', background: 'var(--ok-surface)', color: 'var(--positive)', lineHeight: 1.55 }}>
                  <strong>预检与演练通过</strong><br />{backupSummary}
                  <div><button type="button" disabled={busy} onClick={() => void complete(restoreSelectedBackup)} style={{ ...button, marginTop: 12 }}>恢复这个备份</button></div>
                </div>
              )}
            </div>
          )}

          {choice === 'demo' && (
            <div>
              <h2 style={{ margin: 0, fontSize: 'var(--fs-heading)' }}>创建演示账本</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-body)', lineHeight: 1.6 }}>将写入用于体验功能的模拟资产、流水、定投、游戏和物品数据。它不会被伪装成正式账本。</p>
              <button type="button" disabled={busy} onClick={() => void complete(() => initializeDemoLedger(store))} style={{ ...button, opacity: busy ? 0.55 : 1 }}>{busy ? '正在创建…' : '创建演示账本'}</button>
            </div>
          )}

          <div aria-live="polite" style={{ minHeight: 20, marginTop: 14, color: 'var(--negative)', fontSize: 'var(--fs-body)' }}>{error}</div>
          </section>
        )}
        {!choice && <div aria-live="polite" style={{ minHeight: 20, marginTop: 14, color: 'var(--negative)', fontSize: 'var(--fs-body)' }}>{error}</div>}
      </section>
    </main>
  );
}
