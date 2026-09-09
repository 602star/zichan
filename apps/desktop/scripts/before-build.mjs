import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { npmCli, root } from '../../../scripts/dev/runner.mjs';

// Only the release launcher sets this after building successfully in the same invocation.
if (process.env.ZICHAN_BUILD_PREPARED === '1') {
  for (const path of ['apps/web/dist/index.html', 'apps/sync-server/dist/server.mjs']) {
    if (!existsSync(join(root, path))) throw new Error(`Prepared build is missing ${path}`);
  }
} else {
  const result = spawnSync(process.execPath, [npmCli(), 'run', 'build:server'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const resources = spawnSync(process.execPath, [join(root, 'apps/desktop/scripts/prepare-resources.mjs')], { cwd: join(root, 'apps/desktop'), stdio: 'inherit', windowsHide: true });
if (resources.error) throw resources.error;
process.exitCode = resources.status ?? 1;
