import { dirname, resolve, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';

function samePath(left: string, right: string): boolean {
  if (process.platform !== 'win32') return left === right;
  return toNamespacedPath(left).toLowerCase() === toNamespacedPath(right).toLowerCase();
}

export function requireExplicitDataDir(value: string | undefined, expectedValue: string): string {
  const configured = value?.trim();
  if (!configured) {
    throw new Error('便携同步服务器缺少 DATA_DIR，已拒绝启动；不会回退到 AppData 或用户目录');
  }
  const actual = resolve(configured);
  const expected = resolve(expectedValue);
  if (!samePath(actual, expected)) {
    throw new Error(`便携同步服务器 DATA_DIR 必须严格等于 ${expected}；已拒绝写入其他目录`);
  }
  return expected;
}

export function developmentDataDir(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', 'server-data');
}
