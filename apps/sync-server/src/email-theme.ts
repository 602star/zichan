/**
 * Shared HTML email templates in the 「有本 · 大福帳」 visual language.
 *
 * Uses table-safe inline styles for broad email-client compatibility while
 * keeping the same archival paper, sumi bookcloth header, double-hairline
 * ledger rules, vermilion seal, and income-indigo / expense-crimson / warning-ochre
 * semantics as the web, desktop, and exported PDF surfaces.
 */

export const EMAIL_THEME = {
  bg: '#ebe7dc',
  surface: '#faf8f3',
  surface2: '#f2efe6',
  border: '#d2cbbd',
  borderRow: '#e6e0d4',
  borderStrong: '#3a342c',
  fg: '#211d18',
  fgMuted: '#565048',
  fgSubtle: '#615b52',
  sidebarBg: '#25211d',
  sidebarFg: '#ebe5da',
  sidebarMuted: '#b8afa2',
  sidebarBrand: '#ee7868',
  accent: '#b63226',
  accentSoft: '#f2ded9',
  positive: '#2b6079',
  negative: '#a72f24',
  warning: '#76531c',
  warnSurface: '#f3ead9',
  dangerSurface: '#f4e0dc',
  fontBody: "'LXGW WenKai Screen','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  fontNumeric: "'DIN Alternate','Bahnschrift','SF Pro Display','Segoe UI','Helvetica Neue',Arial,sans-serif",
} as const;

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface LedgerEmailShellInput {
  badge: string;
  sealText: string;
  title: string;
  subtitle?: string;
  accentColor?: string;
  maxWidth?: number;
  bodyHtml: string;
  footerText: string;
}

/**
 * Shared 「有本 · 大福帳」 email frame:
 * archival paper canvas, dark sumi bookcloth header with a vermilion seal,
 * double-hairline divider, and ledger colophon footer.
 */
export function renderLedgerEmailShell(input: LedgerEmailShellInput): string {
  const accent = input.accentColor ?? EMAIL_THEME.accent;
  const maxWidth = input.maxWidth ?? 600;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:${EMAIL_THEME.bg};font-family:${EMAIL_THEME.fontBody};color:${EMAIL_THEME.fg};">
  <div style="max-width:${maxWidth}px;margin:0 auto;background:${EMAIL_THEME.surface};border-radius:8px;border:1px solid ${EMAIL_THEME.border};overflow:hidden;">
    <div style="padding:20px 24px;background:${EMAIL_THEME.sidebarBg};color:${EMAIL_THEME.sidebarFg};border-bottom:3px solid ${accent};">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:top;padding-right:12px;">
            <div style="font-size:12px;color:${EMAIL_THEME.sidebarMuted};letter-spacing:0.6px;">有本 · ${escapeEmailHtml(input.badge)}</div>
            <h1 style="margin:6px 0 4px;font-size:20px;line-height:1.35;font-weight:700;color:${EMAIL_THEME.sidebarFg};">${escapeEmailHtml(input.title)}</h1>
            ${input.subtitle ? `<div style="font-size:13px;color:${EMAIL_THEME.sidebarMuted};font-variant-numeric:tabular-nums;">${escapeEmailHtml(input.subtitle)}</div>` : ''}
          </td>
          <td style="vertical-align:top;text-align:right;white-space:nowrap;">
            <span style="display:inline-block;padding:2px 8px;border:1.5px solid ${EMAIL_THEME.sidebarBrand};border-radius:2px;color:${EMAIL_THEME.sidebarBrand};font-size:12px;font-weight:700;letter-spacing:1.2px;line-height:1.4;">${escapeEmailHtml(input.sealText)}</span>
          </td>
        </tr>
      </table>
    </div>
    <div style="height:3px;background:${EMAIL_THEME.surface};border-bottom:1px solid ${EMAIL_THEME.border};"></div>
    <div style="padding:22px 24px;">
      ${input.bodyHtml}
    </div>
    <div style="padding:14px 24px;background:${EMAIL_THEME.surface2};border-top:1px solid ${EMAIL_THEME.border};font-size:12px;line-height:1.6;color:${EMAIL_THEME.fgSubtle};">
      ${escapeEmailHtml(input.footerText)}
    </div>
  </div>
</body>
</html>`;
}

export function renderVerificationCodeEmailHtml(input: {
  badge: string;
  sealText: string;
  title: string;
  lead: string;
  code: string;
  validityNote: string;
  safetyNote: string;
}): string {
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:${EMAIL_THEME.fgMuted};">${escapeEmailHtml(input.lead)}</p>
    <div style="margin:18px 0;padding:18px 20px;background:${EMAIL_THEME.surface2};border:1px solid ${EMAIL_THEME.border};border-top:2px solid ${EMAIL_THEME.borderStrong};border-radius:4px;text-align:center;">
      <div style="font-size:12px;color:${EMAIL_THEME.fgSubtle};letter-spacing:0.6px;margin-bottom:8px;">一次性验证码</div>
      <div style="font-family:${EMAIL_THEME.fontNumeric};font-size:30px;font-weight:700;letter-spacing:6px;color:${EMAIL_THEME.accent};font-variant-numeric:tabular-nums;">${escapeEmailHtml(input.code)}</div>
    </div>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:${EMAIL_THEME.fg};">${escapeEmailHtml(input.validityNote)}</p>
    <p style="margin:0;font-size:12px;line-height:1.7;color:${EMAIL_THEME.fgSubtle};">${escapeEmailHtml(input.safetyNote)}</p>
  `;
  return renderLedgerEmailShell({
    badge: input.badge,
    sealText: input.sealText,
    title: input.title,
    maxWidth: 520,
    bodyHtml,
    footerText: '有本 · 大福帳 · 个人收支与多资产总账（此为系统安全通知，请勿直接回复）',
  });
}

export function renderNoticeEmailHtml(input: {
  badge: string;
  sealText: string;
  title: string;
  subtitle?: string;
  tone?: 'accent' | 'warning' | 'danger' | 'positive';
  body: string;
  detailBlock?: string;
  footerText?: string;
}): string {
  const accentColor = input.tone === 'warning'
    ? EMAIL_THEME.warning
    : input.tone === 'danger'
      ? EMAIL_THEME.negative
      : input.tone === 'positive'
        ? EMAIL_THEME.positive
        : EMAIL_THEME.accent;
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.75;color:${EMAIL_THEME.fg};white-space:pre-line;">${escapeEmailHtml(block)}</p>`)
    .join('');
  const detailHtml = input.detailBlock
    ? `<div style="margin-top:16px;padding:12px 14px;background:${EMAIL_THEME.surface2};border:1px solid ${EMAIL_THEME.border};border-top:2px solid ${EMAIL_THEME.borderStrong};border-radius:4px;">
        <div style="font-size:12px;font-weight:600;color:${EMAIL_THEME.fgSubtle};margin-bottom:6px;">事件明细</div>
        <pre style="margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;color:${EMAIL_THEME.fgMuted};white-space:pre-wrap;word-break:break-all;">${escapeEmailHtml(input.detailBlock)}</pre>
      </div>`
    : '';
  return renderLedgerEmailShell({
    badge: input.badge,
    sealText: input.sealText,
    title: input.title,
    subtitle: input.subtitle,
    accentColor,
    maxWidth: 560,
    bodyHtml: `${paragraphs}${detailHtml}`,
    footerText: input.footerText ?? '有本 · 大福帳 · 同步服务通知',
  });
}
