/** Public login failures distinguish expired exchanges from rejected password proofs. */
export function loginFailure(reason: string): { status: number; code: string; error: string } {
  // Historical log backfills still contain failures from the old IP-bound path.
  if (reason === 'ip_changed') return {
    status: 409, code: 'LOGIN_SOURCE_CHANGED', error: '登录来源发生变化，请重新登录',
  };
  if (reason === 'expired') return {
    status: 410, code: 'LOGIN_STATE_EXPIRED', error: '登录验证已超时，请重新登录',
  };
  if (['missing', 'already_used', 'raced', 'invalid_state_id'].includes(reason)) return {
    status: 409, code: 'LOGIN_STATE_INVALID', error: '本次登录验证已失效，请重新登录',
  };
  if (reason === 'credentials_changed') return {
    status: 401, code: 'LOGIN_CREDENTIALS_CHANGED', error: '登录期间账号凭据发生变化，请重新登录',
  };
  return { status: 401, code: 'INVALID_CREDENTIALS', error: '账号或密码不正确' };
}
