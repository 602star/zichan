import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptJson, encryptJson, newId, sha256Json, unlockLedgerKeyEnvelope } from '../../../packages/core/dist/index.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'review-owner-account-password';
const keyPassword = 'review-owner-key-password';
const setupToken = 'review-owner-setup-secret-000000';

async function openSync(page) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
  await page.getByRole('button', { name: '查看账本副本与状态' }).click();
  const settings = page.getByRole('button', { name: /^客户端同步与服务器连接/ });
  if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
}

test.setTimeout(90_000);

test('owner reviews a quarantined write and merges its changed field in the browser', async ({ page }) => {
  page.setDefaultTimeout(20_000);
  const dataRoot = mkdtempSync(join(tmpdir(), 'zichan-review-browser-'));
  const node = createSyncServer({ dataDir: dataRoot, registrationMode: 'open',
    ownerSetupToken: setupToken, allowInsecureHttp: true,
    webDir: resolve(root, 'apps/web/dist'), enableWeb: true });
  let store;
  try {
    await node.ready;
    await new Promise((done) => node.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${node.server.address().port}`;
    await registerAccount(url, 'owner', password, { ownerSetupToken: setupToken });
    await page.goto(`${url}/app/`);
    await page.getByLabel('服务器用户名').fill('owner');
    await page.getByLabel('服务器账号密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录已有账号' }).click();
    await page.getByRole('button', { name: '创建个人账本' }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await page.getByRole('button', { name: /^\+ 记(支出|账)$/ }).click();
    await page.getByRole('textbox', { name: /^金额/ }).fill('12.34');
    await page.getByLabel('描述').fill('review-current');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('review-current', { exact: true })).toBeVisible();
    await openSync(page);
    await page.getByRole('button', { name: '同步此服务器', exact: true }).click();
    await expect(page.getByRole('button', { name: '同步此服务器', exact: true })).toBeEnabled();

    await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
    const accountKey = page.getByRole('region', { name: '账号加密密钥' });
    await accountKey.getByLabel('创建账号加密密钥密码').fill(keyPassword);
    await accountKey.getByLabel('确认账号加密密钥密码').fill(keyPassword);
    await accountKey.getByRole('button', { name: '建立账号加密密钥' }).click();
    await expect(accountKey.getByText(/已建立 · 身份节点/)).toBeVisible();
    await openSync(page);
    const members = page.getByRole('region', { name: '账本成员' });
    await members.getByLabel('成员管理密钥密码').fill(keyPassword);
    await members.getByRole('button', { name: '启用成员控制（试用）' }).click();
    await expect(members.getByText(/控制版本 1 · 密钥代次 1/)).toBeVisible();

    const owner = await loginAccount(url, 'owner', password);
    const protectionResponse = await fetch(`${url}/api/v3/protection`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    expect(protectionResponse.ok).toBe(true);
    const protection = await protectionResponse.json();
    const session = await unlockLedgerKeyEnvelope(protection.secret, protection.envelope);
    const ledgerId = protection.replica.ledgerId;
    store = new SyncServerStore(join(dataRoot, 'server.sqlite'), 'open', node.serverId);
    await store.ready;
    const commits = (await store.listCommits('owner', 0, 100)).commits;
    let original;
    for (const item of commits) {
      const commit = await decryptJson(session, item.encCommit, {
        protocol: 2, ledgerId, commitId: item.commitId, contentHash: item.contentHash,
      });
      if (commit.revisions.some((revision) => revision.payload?.transaction?.description === 'review-current')) {
        original = commit;
        break;
      }
    }
    expect(original).toBeTruthy();
    const rejected = structuredClone(original);
    rejected.commitId = newId();
    for (const revision of rejected.revisions) {
      revision.revisionId = newId();
      if (revision.payload?.transaction?.description === 'review-current') {
        revision.payload.transaction.description = 'review-rejected';
      }
    }
    const contentHash = await sha256Json(rejected);
    await store.recordRejectedNodeCommit('owner', 'peer-review-source-0001', {
      commitId: rejected.commitId, ledgerId, contentHash, keyEpoch: 0,
      encCommit: await encryptJson(session, rejected, {
        protocol: 2, ledgerId, commitId: rejected.commitId, contentHash,
      }),
    }, 'STALE_EPOCH');

    await members.getByRole('button', { name: '刷新' }).click();
    await expect(members.getByText('有 1 条节点写入待处理')).toBeVisible();
    await members.getByText('查看隔离记录').click();
    await members.getByRole('button', { name: '查看待审核内容' }).click();
    await expect(members.getByText(`已校验的隔离提交 ${rejected.commitId}`)).toBeVisible();
    await members.getByText('手动合并已变化的记录').click();
    const field = members.getByRole('combobox', { name: / transaction 最终值$/ });
    await expect(field).toBeVisible();
    const merge = members.getByRole('button', { name: '创建手动合并提交并签名处置' });
    await expect(merge).toBeDisabled();
    await field.selectOption('rejected');
    await members.getByLabel('我已核对上述业务内容，并确认选择处置方式').check();
    await expect(merge).toBeEnabled();
    await merge.click();
    await expect(members.getByText('已签名记录手动合并决定，节点将在后台收敛')).toBeVisible();
    await expect.poll(async () => (await store.listRejectedNodeCommits('owner'))[0]?.resolution?.decision)
      .toBe('replay');
    await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(page.getByText('review-rejected', { exact: true })).toBeVisible();
  } finally {
    await page.close();
    await store?.close();
    node.server.closeAllConnections();
    await node.close();
    const safePrefix = `${resolve(tmpdir())}${sep}zichan-review-browser-`;
    if (!resolve(dataRoot).startsWith(safePrefix)) throw new Error('unsafe review test directory');
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
