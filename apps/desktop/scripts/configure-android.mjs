import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const gradlePath = resolve(here, '../src-tauri/gen/android/app/build.gradle.kts');

if (!existsSync(gradlePath)) {
  throw new Error('Android 工程尚未生成，请先运行 npm run android:init -w @zichan/desktop');
}

const source = readFileSync(gradlePath, 'utf8');
const disabled = 'manifestPlaceholders["usesCleartextTraffic"] = "false"';
const enabled = 'manifestPlaceholders["usesCleartextTraffic"] = "true"';

if (source.includes(enabled)) {
  console.log('Android 局域网 HTTP 已启用。');
} else if (source.includes(disabled)) {
  writeFileSync(gradlePath, source.replace(disabled, enabled));
  console.log('已允许 Android 发布包访问局域网 HTTP 同步服务器；公网服务器仍应使用 HTTPS。');
} else {
  throw new Error(`无法定位 usesCleartextTraffic 配置，请检查 ${gradlePath}`);
}
