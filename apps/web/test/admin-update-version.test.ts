import { describe, expect, it } from 'vitest';
import { isOlderStableVersion } from '../src/admin/UpdatePanel.js';

describe('installed server rollback versions', () => {
  it('accepts older stable versions across minor and major boundaries', () => {
    expect(isOlderStableVersion('0.5.3', '0.5.4')).toBe(true);
    expect(isOlderStableVersion('0.4.99', '0.5.4')).toBe(true);
    expect(isOlderStableVersion('0.9.99', '1.0.0')).toBe(true);
  });

  it('rejects equal, newer, and prerelease versions', () => {
    expect(isOlderStableVersion('0.5.4', '0.5.4')).toBe(false);
    expect(isOlderStableVersion('0.6.0', '0.5.4')).toBe(false);
    expect(isOlderStableVersion('0.5.3-rc.1', '0.5.4')).toBe(false);
  });
});
