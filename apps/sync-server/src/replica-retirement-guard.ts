import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_REPLICA_RETIREMENT_MARKER = 'local-replica-retirement.pending.json';

export function assertNoPendingLocalReplicaRetirement(dataDir: string): void {
  if (existsSync(join(dataDir, LOCAL_REPLICA_RETIREMENT_MARKER))) {
    throw new Error('本节点有未完成的单副本清理；请停服后重新运行相同维护命令，不得启动服务重建旧附件索引');
  }
}
