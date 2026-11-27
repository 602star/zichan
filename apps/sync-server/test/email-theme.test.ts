import { describe, expect, it } from 'vitest';
import {
  EMAIL_THEME,
  renderLedgerEmailShell,
  renderNoticeEmailHtml,
  renderVerificationCodeEmailHtml,
} from '../src/email-theme.js';
import { parseUserNotificationPreferences } from '../src/user-reports.js';

describe('大福帳 email theme templates', () => {
  it('renders the shared archival paper shell with sumi header and vermilion seal', () => {
    const html = renderLedgerEmailShell({
      badge: '月度清册',
      sealText: '有本清册',
      title: '2026 年 11 月收支汇总',
      subtitle: '周期：2026-11-01 至 2026-11-30',
      bodyHtml: '<p>正文内容</p>',
      footerText: '页脚说明',
    });
    expect(html).toContain(EMAIL_THEME.bg);
    expect(html).toContain(EMAIL_THEME.surface);
    expect(html).toContain(EMAIL_THEME.sidebarBg);
    expect(html).toContain(EMAIL_THEME.sidebarBrand);
    expect(html).toContain('有本清册');
    expect(html).toContain('2026 年 11 月收支汇总');
  });

  it('escapes user-controlled text in verification code emails', () => {
    const html = renderVerificationCodeEmailHtml({
      badge: '邮箱身份验证',
      sealText: '邮箱核验',
      title: '验证绑定邮箱',
      lead: '测试 <script>alert(1)</script>',
      code: '12345678',
      validityNote: '10 分钟内有效',
      safetyNote: '忽略此邮件',
    });
    expect(html).toContain('12345678');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renders notice emails with tone accent and optional detail block', () => {
    const html = renderNoticeEmailHtml({
      badge: '服务器运维告警',
      sealText: '运维告警',
      title: '磁盘空间偏低',
      tone: 'danger',
      body: '第一段提示\n\n第二段建议',
      detailBlock: '{"freeBytes": 1024}',
    });
    expect(html).toContain(EMAIL_THEME.negative);
    expect(html).toContain('运维告警');
    expect(html).toContain('事件明细');
    expect(html).toContain('freeBytes');
  });

  it('parses per-rule notification channel routing and keeps undefined when omitted', () => {
    const parsed = parseUserNotificationPreferences({
      daily: { enabled: true, hour: 21, skipIfEmpty: true, channels: ['webhook:我的 Bark', 'invalid', 'webhook:我的 Bark'] },
      monthly: { enabled: true, mode: 'calendar', paydayDay: 1, hour: 9, channels: ['email'] },
      weekly: { enabled: true, dayOfWeek: 1, hour: 9 },
    });
    expect(parsed.daily.channels).toEqual(['webhook:我的 Bark']);
    expect(parsed.monthly.channels).toEqual(['email']);
    expect(parsed.weekly.channels).toBeUndefined();
  });
});
