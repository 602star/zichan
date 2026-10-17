import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const gradlePath = resolve(here, '../src-tauri/gen/android/app/build.gradle.kts');

if (!existsSync(gradlePath)) {
  throw new Error('Android 工程尚未生成，请先运行 npm run android:init -w @zichan/desktop');
}

const source = readFileSync(gradlePath, 'utf8');
const enabled = 'manifestPlaceholders["usesCleartextTraffic"] = "true"';
const releaseHeader = 'getByName("release") {';
const newline = source.includes('\r\n') ? '\r\n' : '\n';
const releaseSetting = `${releaseHeader}${newline}            ${enabled}`;

if (source.includes(releaseSetting)) {
  console.log('Android 局域网 HTTP 已启用。');
} else if (source.includes(releaseHeader)) {
  writeFileSync(gradlePath, source.replace(releaseHeader, releaseSetting));
  console.log('已允许 Android 发布包访问局域网 HTTP 同步服务器；公网服务器仍应使用 HTTPS。');
} else {
  throw new Error(`无法定位 Android release 配置，请检查 ${gradlePath}`);
}
