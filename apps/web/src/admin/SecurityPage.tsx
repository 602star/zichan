/**
 * Second factor for the administrator's own account.
 *
 * The page is deliberately self-service: an administrator enrolls their own authenticator, and
 * nobody — not even the owner — can enroll or read it for them. What the page shows the owner is
 * only the list of accounts that would be locked out if the requirement were switched on.
 */
import { useEffect, useState } from 'react';
import type { AdminClient } from './client.js';
import { adminIdempotencyKey } from './idempotency.js';
import { Badge, Button, Field, Loading, Notice, Panel, Stat, TextInput, message, row, useActionError, useResource, when } from './ui.js';
import type { MfaStatusPayload } from './types.js';

interface Enrollment {
  secret: string;
  otpauthUrl: string;
}

export function SecurityPage({ client, username, role, onPasswordChanged }: {
  client: AdminClient; username: string; role: string;
  /** Called after the account password changed: every session is gone, so the console must sign out. */
  onPasswordChanged?: () => void;
}) {
  const status = useResource(() => client.request<MfaStatusPayload>('/mfa'), []);
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [code, setCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const passwordError = useActionError();
  const [passwordNotice, setPasswordNotice] = useState('');

  // A change of enrollment state invalidates whatever half-finished flow was on screen. Recovery
  // codes are deliberately not cleared here: the reload that follows a successful confirmation
  // would otherwise wipe the one and only chance to write them down.
  useEffect(() => { setEnrollment(undefined); setCode(''); setDisableCode(''); }, [status.data?.enabled, status.data?.pending]);

  if (status.loading && !status.data) return <><h2>账号安全</h2><Loading loading error={status.error} /></>;
  if (!status.data) return <><h2>账号安全</h2><Loading loading={false} error={status.error} /></>;

  const data = status.data;

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true); setNotice(''); setError('');
    try { await work(); } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  };

  const changeOwnPassword = async (): Promise<void> => {
    if (nextPassword.length < 8) { passwordError.setError('新账号密码至少八位。'); return; }
    if (nextPassword !== confirmation) { passwordError.setError('两次输入的新密码不一致。'); return; }
    setBusy(true); passwordError.clear(); setPasswordNotice('');
    try {
      await client.changePassword(currentPassword, nextPassword);
      setCurrentPassword(''); setNextPassword(''); setConfirmation('');
      setPasswordNotice('账号密码已修改。为安全起见，此账号的全部登录会话（包括当前这个管理后台）都已失效，请用新密码重新登录。');
      onPasswordChanged?.();
    } catch (caught) {
      passwordError.setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const begin = () => run(async () => {
    const result = await client.request<Enrollment>('/mfa/enroll', {}, { idempotencyKey: adminIdempotencyKey('mfa-enroll') });
    setEnrollment(result);
    setNotice('已生成新的绑定密钥，请立即用验证书扫码或手动输入；未确认前不会生效。');
  });

  const confirm = () => run(async () => {
    const result = await client.request<{ recoveryCodes: string[] }>('/mfa/confirm', { code: code.trim(), requestId: adminIdempotencyKey('mfa-confirm') });
    setRecoveryCodes(result.recoveryCodes);
    setEnrollment(undefined); setCode('');
    setNotice('两步验证已启用。请立即保存下面的恢复码：关闭页面后将无法再次查看。');
    status.reload();
  });

  const disable = () => run(async () => {
    await client.request('/mfa/disable', { code: disableCode.trim(), requestId: adminIdempotencyKey('mfa-disable') });
    setDisableCode(''); setRecoveryCodes([]);
    setNotice('两步验证已关闭，管理后台登录不再要求验证码。');
    status.reload();
  });

  const regenerate = () => run(async () => {
    const result = await client.request<{ recoveryCodes: string[] }>('/mfa/recovery-codes', { code: code.trim(), requestId: adminIdempotencyKey('mfa-recovery') });
    setRecoveryCodes(result.recoveryCodes); setCode('');
    setNotice('已生成新的恢复码，旧恢复码全部作废。请立即保存。');
    status.reload();
  });

  return (
    <>
      <h2>账号安全</h2>
      <Loading loading={status.loading} error={status.error} stale={status.stale} loadedAt={status.loadedAt} />
      <p>{data.note}</p>

      <Panel title="我的账号密码" note={`当前账号：${username}`}>
        <p style={{ marginTop: 0 }}>修改后，此账号的<strong>全部登录会话</strong>都会失效（包括当前这个管理后台与其他设备），需要用新密码重新登录。账本、恢复码与两步验证设置不受影响，未同步的数据仍保留在本机。</p>
        <div style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
          <Field label="当前账号密码">
            <TextInput aria-label="当前账号密码" type="password" autoComplete="current-password" value={currentPassword} disabled={busy} onChange={(event) => setCurrentPassword(event.target.value)} />
          </Field>
          <Field label="新账号密码（至少八位）">
            <TextInput aria-label="新账号密码" type="password" autoComplete="new-password" value={nextPassword} disabled={busy} onChange={(event) => setNextPassword(event.target.value)} />
          </Field>
          <Field label="再次输入新密码">
            <TextInput aria-label="再次输入新密码" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} />
          </Field>
          <div>
            <Button disabled={busy || !currentPassword || nextPassword.length < 8 || nextPassword !== confirmation} onClick={() => { void changeOwnPassword(); }}>确认修改账号密码</Button>
          </div>
        </div>
        {passwordNotice ? <Notice tone="info">{passwordNotice}</Notice> : null}
        {passwordError.error ? <Notice tone="bad">{passwordError.error}</Notice> : null}
      </Panel>

      <Panel title="我的两步验证" note={`当前账号：${username}`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Stat label="状态" value={data.enabled ? '已启用' : data.pending ? '待确认' : '未启用'} tone={data.enabled ? undefined : 'warn'} />
          <Stat label="启用时间" value={data.enabledAt ? when(data.enabledAt) : '—'} />
          <Stat label="剩余恢复码" value={`${data.recoveryCodesRemaining} 个`} tone={data.enabled && data.recoveryCodesRemaining <= 2 ? 'warn' : undefined} />
          <Stat label="服务器要求" value={data.required ? '所有管理员必须启用' : '未强制'} hint={data.required ? '未启用的管理员将无法登录管理后台' : '可自行选择是否启用'} />
        </div>
        {data.recoveryCodesRemaining === 0 && data.enabled
          ? <Notice tone="warn">恢复码已用完：一旦丢失验证书设备，将只能通过服务器本地维护程序找回访问。请重新生成恢复码。</Notice>
          : null}
        {notice ? <Notice tone="info">{notice}</Notice> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
      </Panel>

      {!data.enabled && !enrollment
        ? <Panel title="启用两步验证" note="支持任何兼容 TOTP 的验证书应用（Google Authenticator、1Password、Microsoft Authenticator 等）。">
          <Button disabled={busy} onClick={begin}>生成绑定密钥</Button>
        </Panel>
        : null}

      {enrollment
        ? <Panel title="完成绑定" note="绑定密钥只显示这一次，关闭后需要重新生成。">
          <Field label="绑定密钥（手动输入时使用）"><TextInput readOnly value={enrollment.secret} style={{ width: 320, fontFamily: 'monospace' }} /></Field>
          <Field label="otpauth 链接（可复制到支持导入的应用）"><TextInput readOnly value={enrollment.otpauthUrl} style={{ width: '100%', fontFamily: 'monospace' }} /></Field>
          <Field label="输入验证书应用当前显示的 6 位验证码">
            <div style={row}>
              <TextInput aria-label="两步验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={9} value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} style={{ width: 140 }} />
              <Button disabled={busy || !code.trim()} onClick={() => { void confirm(); }}>确认并启用</Button>
              <Button disabled={busy} onClick={() => { setEnrollment(undefined); setCode(''); }}>取消绑定</Button>
            </div>
          </Field>
        </Panel>
        : null}

      {recoveryCodes.length
        ? <Panel title="一次性恢复码" note="每行一个，每个只能使用一次；丢失设备时用它登录，登录后会提示重新绑定。">
          <pre style={{ margin: 0, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-muted)', fontFamily: 'monospace', userSelect: 'all' }}>{recoveryCodes.join('\n')}</pre>
          <Button style={{ marginTop: 10 }} disabled={busy} onClick={() => { setRecoveryCodes([]); setNotice('恢复码已从页面隐藏。'); }}>我已保存，隐藏恢复码</Button>
        </Panel>
        : null}

      {data.enabled
        ? <>
          <Panel title="重新生成恢复码" note="需要输入当前验证码确认身份；生成后旧恢复码立即失效。">
            <div style={row}>
              <TextInput aria-label="重新生成恢复码的验证码" inputMode="numeric" maxLength={9} value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} style={{ width: 140 }} />
              <Button disabled={busy || !code.trim()} onClick={() => { void regenerate(); }}>生成新的恢复码</Button>
            </div>
          </Panel>
          <Panel title="关闭两步验证" note={data.required ? '服务器当前要求管理员必须启用，关闭会被服务端拒绝；请先让所有者关闭该要求。' : '需要输入当前验证码或一枚恢复码确认身份。'}>
            <div style={row}>
              <TextInput aria-label="关闭两步验证的验证码" inputMode="numeric" maxLength={9} value={disableCode} disabled={busy} onChange={(event) => setDisableCode(event.target.value)} style={{ width: 140 }} />
              <Button disabled={busy || !disableCode.trim()} onClick={() => { void disable(); }}>关闭两步验证</Button>
            </div>
          </Panel>
        </>
        : null}

      <Panel title="其他管理员的绑定情况" note="这里只显示账号名，不显示任何密钥；所有人都在本人页面上自行绑定。">
        {role === 'owner'
          ? data.administratorsWithoutMfa.length
            ? <>
              <Notice tone="warn">以下管理员尚未启用两步验证；在“系统设置”里开启要求前，需要他们先各自完成绑定。</Notice>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {data.administratorsWithoutMfa.map((name) => <li key={name}>{name} <Badge tone="warn">未启用</Badge></li>)}
              </ul>
            </>
            : <p><Badge tone="ok">全部管理员都已启用</Badge></p>
          : <p>仅服务器所有者可以查看完整名单；如需确认，请联系所有者。</p>}
      </Panel>
    </>
  );
}

