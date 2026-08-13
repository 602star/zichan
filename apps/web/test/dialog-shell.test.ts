import { describe, expect, it } from 'vitest';
import {
  dialogTabTarget,
  shouldDismissDialog,
  shouldRestoreDialogFocus,
  wrappedDialogFocusIndex,
} from '../src/ui/DialogShell.js';
import { confirmDialogErrorMessage } from '../src/ui/ConfirmDialog.js';
import { formatAppDiagnostic } from '../src/ui/AppErrorBoundary.js';

describe('dialog shell keyboard contract', () => {
  it('wraps focus only at the two edges', () => {
    expect(wrappedDialogFocusIndex(2, 3, false)).toBe(0);
    expect(wrappedDialogFocusIndex(0, 3, true)).toBe(2);
    expect(wrappedDialogFocusIndex(1, 3, false)).toBeNull();
    expect(wrappedDialogFocusIndex(-1, 3, false)).toBe(0);
    expect(wrappedDialogFocusIndex(-1, 3, true)).toBe(2);
    expect(wrappedDialogFocusIndex(-1, 0, false)).toBeNull();
  });

  it('keeps Tab on the dialog panel when every control is disabled', () => {
    expect(dialogTabTarget(-1, 0, false)).toBe('panel');
    expect(dialogTabTarget(-1, 0, true)).toBe('panel');
    expect(dialogTabTarget(1, 3, false)).toBeNull();
  });

  it('accepts Escape only when the dialog is dismissible', () => {
    expect(shouldDismissDialog('Escape', true, true, false)).toBe(true);
    expect(shouldDismissDialog('Enter', true, true, false)).toBe(false);
    expect(shouldDismissDialog('Escape', false, true, false)).toBe(false);
    expect(shouldDismissDialog('Escape', true, false, false)).toBe(false);
    expect(shouldDismissDialog('Escape', true, true, true)).toBe(false);
  });

  it('restores focus only to the page or an active parent dialog', () => {
    const target = {} as Node;
    const parent = { contains: (node: Node) => node === target } as Pick<Node, 'contains'>;
    const replacement = { contains: () => false } as Pick<Node, 'contains'>;
    expect(shouldRestoreDialogFocus(target, [])).toBe(true);
    expect(shouldRestoreDialogFocus(target, [parent])).toBe(true);
    expect(shouldRestoreDialogFocus(target, [replacement])).toBe(false);
  });
});

describe('confirmation action errors', () => {
  it('turns thrown and rejected values into an inline-safe message', () => {
    expect(confirmDialogErrorMessage(new Error('保存失败'))).toBe('保存失败');
    expect(confirmDialogErrorMessage('网络不可用')).toBe('网络不可用');
    expect(confirmDialogErrorMessage(null)).toBe('操作失败，请稍后重试');
  });
});

describe('application error diagnostic', () => {
  it('contains actionable technical context without ledger data', () => {
    const diagnostic = formatAppDiagnostic(new TypeError('chunk failed'), '\n at Reports');
    expect(diagnostic).toContain('TypeError: chunk failed');
    expect(diagnostic).toContain('组件：');
    expect(diagnostic).toContain('at Reports');
    expect(diagnostic).toContain('页面：unknown');
    expect(diagnostic).toMatch(/时间：\d{4}-\d{2}-\d{2}T/);
  });
});
