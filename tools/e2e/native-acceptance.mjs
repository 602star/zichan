import { chromium } from './node_modules/playwright-core/index.mjs';
const action = process.argv[2];
const root = '.runtime/native-acceptance-20260911';
const browser = await chromium.connectOverCDP('http://127.0.0.1:19341');
const page = browser.contexts()[0].pages().find((row) => row.url() === 'http://tauri.localhost/');
if (!page) throw new Error('Native test page unavailable');
page.setDefaultTimeout(20_000);
try {
  if (action === 'offline-ready') {
    const panel = page.getByRole('region', { name: '账本保护', exact: true });
    await panel.getByText('本机离线访问已准备好').waitFor();
    await page.screenshot({ path: `${root}/native-offline-ready.png` });
    console.log('native offline access prepared');
  } else if (action === 'login') {
    await page.getByLabel('服务器账号密码', { exact: true }).fill('native-test-password');
    await page.getByRole('button', { name: '登录已有账号', exact: true }).click();
    await page.locator('.zc-app-shell').waitFor();
    await page.locator('.zc-sidebar').getByRole('button', { name: /日常支出$/ }).click();
    await page.getByText('原生恢复验收', { exact: true }).waitFor();
    console.log('native restarted and recovered the original record');
    await page.screenshot({ path: `${root}/native-restarted.png` });
  } else if (action === 'offline') {
    await page.getByRole('button', { name: '离线打开 native-test 的本机账本', exact: true }).click();
    await page.getByLabel('账号密码', { exact: true }).fill('native-test-password');
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
  } else throw new Error('Expected offline-ready, login, offline, offline-record, verify-crash or inspect');
  process.exit(0);
} catch (error) {
  console.error(error.message);
  console.error((await page.locator('body').innerText()).slice(-3000));
  process.exit(1);
}
