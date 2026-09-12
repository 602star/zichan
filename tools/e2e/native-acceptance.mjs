import { chromium } from './node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const action = process.argv[2];
const root = '.runtime/native-acceptance-20260911';
const browser = await chromium.connectOverCDP('http://127.0.0.1:19341');
const page = browser.contexts()[0].pages().find((row) => row.url() === 'http://tauri.localhost/');
if (!page) throw new Error('Native test page unavailable');
page.setDefaultTimeout(20_000);
try {
  if (action === 'private') {
    const panel = page.getByRole('region', { name: '账本保护', exact: true });
    await panel.getByText('高级：更改保护方式', { exact: true }).click();
    await panel.getByRole('button', { name: '准备切换到私密模式' }).click();
    writeFileSync(`${root}/recovery.txt`, await panel.locator('pre').innerText(), { mode: 0o600 });
    await panel.getByRole('checkbox', { name: /我已保存新恢复码/ }).check();
    await panel.getByRole('button', { name: '确认更改保护方式' }).click();
    await panel.getByText(/保护方式已更新/).waitFor();
    await panel.getByText('此设备的离线访问', { exact: true }).click();
    await panel.getByLabel('设置离线密码').fill('native-offline-password');
    await panel.getByLabel('确认离线密码').fill('native-offline-password');
    await panel.getByRole('button', { name: '设置离线密码', exact: true }).click();
    await panel.getByText('离线密码已设置。', { exact: true }).waitFor();
    await page.screenshot({ path: `${root}/native-private.png` });
    console.log('native protection rotated; offline password configured');
  } else if (action === 'login') {
    await page.getByLabel('服务器账号密码', { exact: true }).fill('native-test-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await page.getByLabel('账本恢复码', { exact: true }).fill(readFileSync(`${root}/recovery.txt`, 'utf8'));
    await page.getByRole('button', { name: '解锁账本', exact: true }).click();
    await page.locator('.zc-app-shell').waitFor();
    await page.locator('.zc-sidebar').getByRole('button', { name: /日常支出$/ }).click();
    await page.getByText('原生恢复验收', { exact: true }).waitFor();
    console.log('native restarted and recovered the original record');
    await page.screenshot({ path: `${root}/native-restarted.png` });
  } else if (action === 'offline') {
    await page.getByRole('button', { name: '离线打开 native-test 的本机账本', exact: true }).click();
    await page.getByLabel('离线密码', { exact: true }).fill('native-offline-password');
    await page.getByRole('button', { name: '解锁缓存', exact: true }).click();
    await page.locator('.zc-app-shell').waitFor();
    await page.locator('.zc-sidebar').getByRole('button', { name: /日常支出$/ }).click();
    await page.getByText('原生恢复验收', { exact: true }).waitFor();
    await page.screenshot({ path: `${root}/native-offline.png` });
    console.log('native cold start recovered the original record while server was stopped');
  } else if (action === 'offline-record') {
    await page.getByRole('button', { name: '+ 记支出' }).click();
    await page.getByRole('textbox', { name: /^金额/ }).fill('25');
    await page.getByLabel('描述').fill('原生断网未同步');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog', { name: '新增 · 日常支出' }).waitFor({ state: 'hidden' });
    await page.getByText('原生断网未同步', { exact: true }).waitFor();
    console.log('offline native record committed before forced termination');
  } else if (action === 'verify-crash') {
    await page.getByText('原生断网未同步', { exact: true }).waitFor();
    await page.screenshot({ path: `${root}/native-crash-recovered.png` });
    console.log('unsynchronized record survived forced native process termination');
  } else if (action === 'inspect') {
    console.log(await page.locator('body').innerText());
  } else throw new Error('Expected private, login, offline, offline-record, verify-crash or inspect');
  process.exit(0);
} catch (error) {
  console.error(error.message);
  console.error((await page.locator('body').innerText()).slice(-3000));
  process.exit(1);
}
