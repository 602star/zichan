import { useEffect, useState } from 'react';
import {
  authenticateBiometric,
  biometricStatus,
  currentDevicePosition,
  readDevicePreferences,
  requestNotificationPermission,
  sendDeviceNotification,
  writeDevicePreferences,
  type BiometricStatus,
  type DevicePreferences,
} from '../device-capabilities.js';
import {
  credentialVaultState,
  lockCredentialVault,
  refreshCredentialVaultState,
  VAULT_STATE_CHANGED_EVENT,
  type CredentialVaultState,
} from '../credential-vault.js';
import { card } from './styles.js';

const outline = { padding: '7px 13px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-muted)', fontWeight: 700, fontSize: 12, cursor: 'pointer' } as const;

function statusText(status: BiometricStatus | null): string {
  if (!status) return '检测中…';
  if (!status.isAvailable) return status.error || '当前设备不可用';
  if (status.biometryType === 2) return 'Face ID / 人脸可用';
  if (status.biometryType === 1) return '指纹 / Touch ID 可用';
  if (status.biometryType === 3) return '虹膜识别可用';
  return '设备验证可用';
}

export function DeviceSecurityPanel() {
  const [preferences, setPreferences] = useState<DevicePreferences>(readDevicePreferences);
  const [biometry, setBiometry] = useState<BiometricStatus | null>(null);
  const [vault, setVault] = useState<CredentialVaultState>(credentialVaultState);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void biometricStatus().then(setBiometry);
    void refreshCredentialVaultState().then(setVault).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    const onPreferences = () => setPreferences(readDevicePreferences());
    const onVault = () => setVault(credentialVaultState());
    window.addEventListener('zichan:device-preferences-changed', onPreferences);
    window.addEventListener(VAULT_STATE_CHANGED_EVENT, onVault);
    return () => {
      window.removeEventListener('zichan:device-preferences-changed', onPreferences);
      window.removeEventListener(VAULT_STATE_CHANGED_EVENT, onVault);
    };
  }, []);

  async function toggleBiometric(enabled: boolean) {
    if (!enabled) {
      setPreferences(writeDevicePreferences({ biometricLock: false }));
      setNotice('应用锁已关闭。');
      return;
    }
    setBusy('biometric');
    setNotice('');
    try {
      const status = await biometricStatus();
      setBiometry(status);
      if (!status.isAvailable) throw new Error(status.error || '当前设备未配置可用的生物识别或设备密码');
      await authenticateBiometric('确认启用账本应用锁');
      setPreferences(writeDevicePreferences({ biometricLock: true }));
      setNotice('应用锁已开启；下次启动或从后台恢复时会验证。');
    } catch (error) {
      setNotice(`未开启应用锁：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  }

  async function toggleNotifications(enabled: boolean) {
    if (!enabled) {
      setPreferences(writeDevicePreferences({ syncNotifications: false }));
      setNotice('同步通知已关闭。');
      return;
    }
    setBusy('notification');
    try {
      const permission = await requestNotificationPermission();
      setNotificationPermission(permission);
      setPreferences(writeDevicePreferences({ syncNotifications: permission === 'granted' }));
      setNotice(permission === 'granted' ? '同步失败或冲突时会发送系统通知。' : '系统未授予通知权限。');
    } catch (error) {
      setNotice(`通知权限申请失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  }

  async function testNotification() {
    setBusy('notification-test');
    const sent = await sendDeviceNotification('资产生命周期', '通知功能工作正常。');
    setNotificationPermission('Notification' in window ? Notification.permission : 'unsupported');
    setNotice(sent ? '测试通知已发送。' : '通知不可用或未授权。');
    setBusy('');
  }

  async function testLocation() {
    setBusy('location');
    try {
      const position = await currentDevicePosition();
      setNotice(`定位成功：${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)} · 精度约 ${Math.round(position.accuracy)} 米`);
    } catch (error) {
      setNotice(`定位失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  }

  async function lockVault() {
    setBusy('vault');
    try {
      await lockCredentialVault();
      setVault(credentialVaultState());
      setNotice('同步凭据已从内存清除；当前账本会在应用关闭时释放数据库密钥。');
    } catch (error) {
      setNotice(`锁定 Stronghold 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={card}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>设备安全与权限</div>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
            {vault.kind === 'native-stronghold'
              ? `${vault.platform} 原生端 · Stronghold 保护数据库密钥、附件密钥和同步凭据`
              : 'Web 浏览器 · 数据库与附件加密保存，账号解锁与离线授权分开管理'}
          </div>
        </div>
        {vault.kind === 'native-stronghold' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {vault.unlocked && <button type="button" onClick={() => void lockVault()} disabled={!!busy} style={outline}>{busy === 'vault' ? '锁定中…' : '锁定 Stronghold'}</button>}
          </div>
        )}
      </div>
      <div className="zc-settings-health-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        <DeviceControl
          label="应用锁"
          value={statusText(biometry)}
          checked={preferences.biometricLock}
          disabled={!biometry?.isAvailable || busy === 'biometric'}
          onChange={(checked) => void toggleBiometric(checked)}
        />
        <DeviceControl
          label="同步通知"
          value={notificationPermission === 'unsupported' ? '当前环境不支持' : `权限：${notificationPermission}`}
          checked={preferences.syncNotifications}
          disabled={notificationPermission === 'unsupported' || busy === 'notification'}
          onChange={(checked) => void toggleNotifications(checked)}
        />
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 11, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 12, fontWeight: 900 }}>设备能力测试</div>
          <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => void testLocation()} disabled={!!busy} style={outline}>{busy === 'location' ? '定位中…' : '测试定位'}</button>
            <button type="button" onClick={() => void testNotification()} disabled={!!busy || notificationPermission === 'unsupported'} style={outline}>测试通知</button>
          </div>
        </div>
      </div>
      {notice && <div style={{ marginTop: 10, color: /失败|未开启|不可用|未授权/.test(notice) ? 'var(--negative)' : 'var(--positive)', fontSize: 12, fontWeight: 700, overflowWrap: 'anywhere' }}>{notice}</div>}
    </div>
  );
}

function DeviceControl(props: { label: string; value: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 11, background: 'var(--surface-2)' }}>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12, fontWeight: 900 }}>
        {props.label}
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      </label>
      <div style={{ marginTop: 8, color: 'var(--fg-subtle)', fontSize: 11, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{props.value}</div>
    </div>
  );
}
