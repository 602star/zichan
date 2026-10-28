import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_LABELS, auditActionLabel, auditTargetLabel } from '../src/admin/audit-presentation.js';

describe('management audit presentation', () => {
  it('gives every known mutation a readable action and preserves unknown codes for details', () => {
    expect(Object.keys(AUDIT_ACTION_LABELS)).toHaveLength(25);
    for (const [code, label] of Object.entries(AUDIT_ACTION_LABELS)) {
      expect(code).toBeTruthy();
      expect(label).toMatch(/[\u4e00-\u9fff]/);
    }
    expect(auditActionLabel('future-action')).toBe('未识别操作');
  });

  it('names a target from its account or system resource', () => {
    expect(auditTargetLabel({ targetName: '小李', targetAccountId: 'account-1', action: 'role' })).toBe('小李');
    expect(auditTargetLabel({ targetName: '', targetAccountId: null, action: 'settings-update' })).toBe('系统配置');
  });
});
