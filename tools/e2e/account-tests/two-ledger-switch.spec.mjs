import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountSigningPublicKey, createAccountEncryptionKey } from '../../../packages/core/dist/index.js';
import { loginAccount, registerAccount } from '../../../packages/db/dist/index.js';
import { NodeSqliteDriver } from '../../../packages/db/dist/node.js';
import { createSyncServer } from '../../../apps/sync-server/dist/server.js';
import { loadNodeIdentity } from '../../../apps/sync-server/dist/node-identity.js';
import { SyncServerStore } from '../../../apps/sync-server/dist/store.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const setupToken = 'two-ledger-owner-setup-secret-000000';
const accountPassword = 'two-ledger-account-password';
const accountPassword = 'two-ledger-member-key-password';
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

function largePng() {
  const text = Buffer.alloc(5 * 1024 * 1024 + 8, 0x41);
  text.write('Comment', 0, 'ascii');
  text[7] = 0;
  const chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write('tEXt', 4, 'ascii');
  text.copy(chunk, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < text.length + 8; index += 1) {
    crc ^= chunk[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, text.length + 8);
  return Buffer.concat([photo.subarray(0, -12), chunk, photo.subarray(-12)]);
}

const largePhoto = largePng();

async function login(page, url, username) {
  await page.goto(`${url}/app/`);
  await page.getByLabel('服务器用户名').fill(username);
  await page.getByLabel('服务器账号密码', { exact: true }).fill(accountPassword);
  await page.getByRole('button', { name: '登录已有账号' }).click();
}

async function openAccount(page) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.locator('.zc-sidebar').getByRole('button', { name: /我的账号$/ }).click();
}

async function syncLedger(page) {
  await openAccount(page);
  await page.getByRole('button', { name: '查看服务器上的账本' }).click();
  const sync = page.getByRole('button', { name: '同步账本', exact: true }).first();
  await sync.click();
  await expect(sync).toBeEnabled();
}

async function saveExpense(page, amount, description, attachmentName) {
  await expect(page.locator('.zc-app-shell')).toBeVisible();
  await page.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
  await page.getByRole('button', { name: /^\+ 记(支出|账)$/ }).click();
  await page.getByRole('textbox', { name: /^金额/ }).fill(amount);
  await page.getByLabel('描述').fill(description);
  if (attachmentName) await page.getByRole('dialog').locator('input[type="file"]').first()
    .setInputFiles({ name: attachmentName, mimeType: 'image/png',
      buffer: attachmentName === 'shared-receipt.png' ? largePhoto : photo });
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).last().click();
  await expect(page.getByText(description, { exact: true })).toBeVisible();
}

async function expectAttachmentPreview(page, description, attachmentName) {
  await page.getByText(description, { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(attachmentName, { exact: true })).toBeVisible();
  await expect.poll(async () => dialog.getByRole('img', { name: attachmentName })
    .evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

async function selectLedger(page, ledgerId) {
  await openAccount(page);
  const chooser = page.getByRole('region', { name: '选择账本' });
  await expect(chooser).toContainText('此账号可进入 2 个账本');
  await chooser.getByLabel('账本副本').selectOption({ label: ledgerId });
  await chooser.getByRole('button', { name: '进入账本' }).click();
}

async function unlockMemberLedger(page) {
  await expect(page.getByRole('heading', { name: '解锁成员账本' })).toBeVisible();
  await page.getByLabel('成员账本账号密码', { exact: true }).fill(accountPassword);
  await page.getByRole('button', { name: '解锁账本', exact: true }).click();
  await expect(page.locator('.zc-app-shell')).toBeVisible();
}

test('switches personal and invited ledgers across three sites through a hub outage', async ({ page, browser }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  const dataRoot = mkdtempSync(join(tmpdir(), 'zichan-two-ledger-web-'));
  const node = createSyncServer({ dataDir: dataRoot, registrationMode: 'open',
    ownerSetupToken: setupToken, allowInsecureHttp: true,
    webDir: resolve(root, 'apps/web/dist'), enableWeb: true });
  let store;
  let aliceContext;
  const peerNodes = [];
  const peerStores = [];
  try {
    await node.ready;
    await new Promise((done) => node.server.listen(0, '127.0.0.1', done));
    const hubPort = node.server.address().port;
    const url = `http://127.0.0.1:${hubPort}`;
    await registerAccount(url, 'owner', accountPassword, { ownerSetupToken: setupToken });
    await registerAccount(url, 'alice', accountPassword);
    store = new SyncServerStore(join(dataRoot, 'server.sqlite'), 'open', node.serverId);
    await store.ready;
    const owner = await store.getUser('owner');
    const alice = await store.getUser('alice');
    const memberKey = await createAccountEncryptionKey(node.serverId, alice.accountId, accountPassword);
    const identityCard = JSON.stringify({ issuerNodeId: node.serverId, accountId: alice.accountId,
      encryptionPublicKey: memberKey.envelope.publicKey,
      signingPublicKey: accountSigningPublicKey(memberKey.privateKey) });
    await store.putAccountEncryptionKey(node.serverId, alice.accountId, memberKey.envelope.publicKey,
      memberKey.envelope, 0);
    memberKey.privateKey.fill(0);

    await login(page, url, 'owner');
    await page.getByRole('button', { name: '创建个人账本' }).click();
    await page.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(page.locator('.zc-app-shell')).toBeVisible();
    await page.keyboard.press('Escape');
    await saveExpense(page, '11.11', 'shared-owner-entry');
    await syncLedger(page);
    const sharedLedgerId = (await store.getReplica('owner')).ledgerId;
    await expect.poll(async () => (await store.replicaInventory('owner', sharedLedgerId)).commitCount)
      .toBeGreaterThan(0);
    await openAccount(page);
    const ownerKey = page.getByRole('region', { name: '账号加密密钥' });
    await ownerKey.getByLabel('创建账号加密密钥密码').fill(accountPassword);
    await ownerKey.getByLabel('确认账号加密密钥密码').fill(accountPassword);
    await ownerKey.getByRole('button', { name: '建立账号加密密钥' }).click();
    await expect(ownerKey.getByText(/已建立 · 身份节点/)).toBeVisible();
    await page.getByRole('button', { name: '查看服务器上的账本' }).click();
    const members = page.getByRole('region', { name: '账本成员' });
    await members.getByLabel('成员管理密钥密码').fill(accountPassword);
    await members.getByRole('button', { name: '启用成员控制（试用）' }).click();
    await expect(members.getByText(/控制版本 1 · 密钥代次 1/)).toBeVisible();

    aliceContext = await browser.newContext();
    let alicePage = await aliceContext.newPage();
    alicePage.setDefaultTimeout(20_000);
    await login(alicePage, url, 'alice');
    await alicePage.getByRole('button', { name: '创建个人账本' }).click();
    await alicePage.getByRole('button', { name: '开始记账', exact: true }).click();
    await expect(alicePage.locator('.zc-app-shell')).toBeVisible();
    await alicePage.keyboard.press('Escape');
    await saveExpense(alicePage, '22.22', 'personal-alice-entry', 'personal-receipt.png');
    await syncLedger(alicePage);
    const personalLedgerId = (await store.getReplica('alice')).ledgerId;
    expect(personalLedgerId).not.toBe(sharedLedgerId);
    await expect.poll(async () => {
      const inventory = await store.replicaInventory('alice', personalLedgerId);
      return inventory.commitCount > 0 && inventory.blobCount > 0;
    }).toBe(true);
    const aliceApi = await loginAccount(url, 'alice', accountPassword);
    const personalProtection = await (await fetch(`${url}/api/v3/protection`, {
      headers: { Authorization: `Bearer ${aliceApi.accessToken}` },
    })).json();
    expect(personalProtection).toMatchObject({ mode: 'managed', replica: { ledgerId: personalLedgerId } });
    expect(personalProtection.secret).toBeTruthy();

    await members.getByText('邀请成员').click();
    await members.getByLabel('待邀请成员身份').fill(identityCard);
    await members.getByRole('button', { name: '加入账本' }).click();
    await expect(members.getByText('成员已加入账本')).toBeVisible();

    await selectLedger(alicePage, sharedLedgerId);
    await unlockMemberLedger(alicePage);
    await saveExpense(alicePage, '33.33', 'shared-alice-entry', 'shared-receipt.png');
    await syncLedger(alicePage);
    await expect.poll(async () => {
      const inventory = await store.replicaInventory('owner', sharedLedgerId);
      return inventory.commitCount > 1 && inventory.blobCount > 0;
    }).toBe(true);
    const sharedReplicaId = (await store.getReplica('owner')).replicaId;
    const attachmentIndex = new NodeSqliteDriver(join(dataRoot, 'server.sqlite'));
    try {
      const sharedPhoto = await attachmentIndex.get(`SELECT chunk_count AS chunks, cipher_bytes AS bytes
        FROM blob_objects WHERE replica_id = ? AND state = 'available'
          AND json_extract(manifest_json, '$.v') = 2`, [sharedReplicaId]);
      expect(Number(sharedPhoto?.chunks)).toBeGreaterThan(1);
      expect(Number(sharedPhoto?.bytes)).toBeGreaterThan(5 * 1024 * 1024);
    } finally { await attachmentIndex.close(); }
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(alicePage.getByText('shared-owner-entry', { exact: true })).toBeVisible();
    await expect(alicePage.getByText('personal-alice-entry', { exact: true })).toHaveCount(0);

    await selectLedger(alicePage, personalLedgerId);
    await expect(alicePage.locator('.zc-app-shell')).toBeVisible();
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(alicePage.getByText('personal-alice-entry', { exact: true })).toBeVisible();
    await expect(alicePage.getByText('shared-alice-entry', { exact: true })).toHaveCount(0);
    const databases = await alicePage.evaluate(async () => (await indexedDB.databases())
      .map((database) => database.name).filter((name) => name?.endsWith(':database')));
    expect(databases).toHaveLength(2);
    await selectLedger(alicePage, sharedLedgerId);
    await unlockMemberLedger(alicePage);
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(alicePage.getByText('shared-alice-entry', { exact: true })).toBeVisible();
    await expect(alicePage.getByText('personal-alice-entry', { exact: true })).toHaveCount(0);

    // The two upload pages are gone before either peer starts copying commits or chunks.
    await alicePage.close();
    await page.close();
    expect(aliceContext.pages()).toHaveLength(0);
    expect(page.context().pages()).toHaveLength(0);

    const sharedReplica = await store.getReplica('owner');
    const personalReplica = await store.getReplica('alice');
    const sharedEnvelope = await store.getKeyEnvelope('owner', sharedLedgerId);
    const personalEnvelope = await store.getKeyEnvelope('alice', personalLedgerId);
    expect(sharedEnvelope).toBeTruthy();
    expect(personalEnvelope).toBeTruthy();
    const hubPublicKey = loadNodeIdentity(dataRoot, node.serverId).publicKey;
    for (const [index, host] of ['127.0.0.2', '127.0.0.3'].entries()) {
      const peer = createSyncServer({ dataDir: join(dataRoot, index === 0 ? 'home' : 'office'),
        registrationMode: 'open', ownerSetupToken: setupToken, allowInsecureHttp: true,
        webDir: resolve(root, 'apps/web/dist'), enableWeb: true });
      peerNodes.push(peer);
      await peer.ready;
      await new Promise((done) => peer.server.listen(0, host, done));
      peer.url = `http://${host}:${peer.server.address().port}`;
      const peerStore = new SyncServerStore(join(peer.dataDir, 'server.sqlite'), 'open', peer.serverId);
      peerStores.push(peerStore);
      await peerStore.ready;
      const peerPublicKey = loadNodeIdentity(peer.dataDir, peer.serverId).publicKey;
      for (const [username, accountId, ledgerId, replica, envelope] of [
        ['owner', owner.accountId, sharedLedgerId, sharedReplica, sharedEnvelope],
        ['alice', alice.accountId, personalLedgerId, personalReplica, personalEnvelope],
      ]) {
        const grant = await store.createNodeReplicationGrant(username, peer.serverId, peerPublicKey,
          new Date(Date.now() + 86_400_000).toISOString());
        await peerStore.provisionFederatedReplica({
          issuerNodeId: node.serverId, subjectAccountId: accountId, ledgerId,
          envelope, peerUrl: url, peerNodeId: node.serverId, peerPublicKey: hubPublicKey,
          peerReplicaId: replica.replicaId, peerStreamEpoch: replica.streamEpoch,
          grantId: grant.grantId,
        });
      }
      await expect.poll(async () => {
        const links = await peerStore.listNodeReplicationLinks();
        const sharedLink = links.find((link) => link.ledgerId === sharedLedgerId);
        const personalLink = links.find((link) => link.ledgerId === personalLedgerId);
        if (!sharedLink || !personalLink) return false;
        const shared = await peerStore.replicaInventory(sharedLink.username, sharedLedgerId);
        const personal = await peerStore.replicaInventory(personalLink.username, personalLedgerId);
        return shared.commitCount > 1 && personal.commitCount > 0
          && shared.blobCount > 0 && personal.blobCount > 0
          && shared.memberAccountCount === 2 && shared.missingMemberAccountCount === 0;
      }, { timeout: 60_000 }).toBe(true);
    }
    const home = peerNodes[0];
    alicePage = await aliceContext.newPage();
    alicePage.setDefaultTimeout(20_000);
    await alicePage.goto(`${home.url}/app/`);
    await alicePage.getByRole('button', { name: new RegExp(`通过 .* 登录账本 ${sharedLedgerId}`) }).click();
    await unlockMemberLedger(alicePage);
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(alicePage.getByText('shared-alice-entry', { exact: true })).toBeVisible();
    await expect(alicePage.getByText('personal-alice-entry', { exact: true })).toHaveCount(0);
    await expectAttachmentPreview(alicePage, 'shared-alice-entry', 'shared-receipt.png');
    await selectLedger(alicePage, personalLedgerId);
    await expect(alicePage.locator('.zc-app-shell')).toBeVisible();
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(alicePage.getByText('personal-alice-entry', { exact: true })).toBeVisible();
    await expect(alicePage.getByText('shared-alice-entry', { exact: true })).toHaveCount(0);
    await expectAttachmentPreview(alicePage, 'personal-alice-entry', 'personal-receipt.png');
    await saveExpense(alicePage, '44.44', 'personal-home-entry');
    await syncLedger(alicePage);
    await expect.poll(async () => {
      const link = (await peerStores[0].listNodeReplicationLinks())
        .find((item) => item.ledgerId === personalLedgerId);
      return (await peerStores[0].replicaInventory(link.username, personalLedgerId)).commitCount;
    }).toBeGreaterThan(1);
    await home.flushNodeReplication();
    const office = peerNodes[1];
    await office.flushNodeReplication();
    await alicePage.goto(`${office.url}/app/`);
    await alicePage.getByRole('button', { name: new RegExp(`通过 .* 登录账本 ${sharedLedgerId}`) }).click();
    await unlockMemberLedger(alicePage);
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    await expect(alicePage.getByText('shared-alice-entry', { exact: true })).toBeVisible();
    await expect(alicePage.getByText('personal-alice-entry', { exact: true })).toHaveCount(0);
    await expectAttachmentPreview(alicePage, 'shared-alice-entry', 'shared-receipt.png');
    await saveExpense(alicePage, '55.55', 'shared-office-entry');
    await syncLedger(alicePage);
    await selectLedger(alicePage, personalLedgerId);
    await expect(alicePage.locator('.zc-app-shell')).toBeVisible();
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    for (const description of ['personal-alice-entry', 'personal-home-entry']) {
      await expect(alicePage.getByText(description, { exact: true })).toBeVisible();
    }
    await expectAttachmentPreview(alicePage, 'personal-alice-entry', 'personal-receipt.png');
    await expect(alicePage.getByText('shared-office-entry', { exact: true })).toHaveCount(0);
    await saveExpense(alicePage, '66.66', 'personal-office-entry');
    await syncLedger(alicePage);
    node.server.closeAllConnections();
    await new Promise((done, fail) => node.server.close((error) => error ? fail(error) : done()));
    await selectLedger(alicePage, sharedLedgerId);
    await unlockMemberLedger(alicePage);
    await saveExpense(alicePage, '77.77', 'shared-office-hub-offline');
    await syncLedger(alicePage);
    await alicePage.goto(`${home.url}/app/`);
    await expect(alicePage.locator('.zc-app-shell')).toBeVisible();
    await saveExpense(alicePage, '88.88', 'personal-home-hub-offline');
    await syncLedger(alicePage);
    await new Promise((done, fail) => {
      node.server.once('error', fail);
      node.server.listen(hubPort, '127.0.0.1', () => {
        node.server.off('error', fail);
        done();
      });
    });
    await expect.poll(async () => {
      await Promise.all(peerNodes.map((peer) => peer.flushNodeReplication()));
      const inventories = await Promise.all([sharedLedgerId, personalLedgerId].map(async (ledgerId) => {
        const hubUsername = ledgerId === sharedLedgerId ? 'owner' : 'alice';
        const source = await store.replicaInventory(hubUsername, ledgerId);
        const peers = await Promise.all(peerStores.map(async (peerStore) => {
          const link = (await peerStore.listNodeReplicationLinks())
            .find((item) => item.ledgerId === ledgerId);
          return peerStore.replicaInventory(link.username, ledgerId);
        }));
        return [source, ...peers];
      }));
      return inventories.every((rows) => rows[0].commitCount >= 4 && rows[0].blobCount > 0
        && rows.every((row) => row.commitCount === rows[0].commitCount
          && row.commitHash === rows[0].commitHash && row.blobCount === rows[0].blobCount
          && row.blobHash === rows[0].blobHash));
    }, { timeout: 45_000 }).toBe(true);

    await alicePage.goto(`${url}/app/`);
    const unlockShared = alicePage.getByRole('heading', { name: '解锁成员账本' });
    await expect(alicePage.locator('.zc-app-shell').or(unlockShared)).toBeVisible();
    if (await unlockShared.isVisible()) await unlockMemberLedger(alicePage);
    await syncLedger(alicePage);
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    for (const description of ['shared-owner-entry', 'shared-alice-entry', 'shared-office-entry',
      'shared-office-hub-offline']) {
      await expect(alicePage.getByText(description, { exact: true })).toBeVisible();
    }
    await expectAttachmentPreview(alicePage, 'shared-alice-entry', 'shared-receipt.png');
    await expect(alicePage.getByText('personal-office-entry', { exact: true })).toHaveCount(0);
    await selectLedger(alicePage, personalLedgerId);
    await expect(alicePage.locator('.zc-app-shell')).toBeVisible();
    await syncLedger(alicePage);
    await alicePage.locator('.zc-sidebar').getByText('日常收支', { exact: true }).click();
    for (const description of ['personal-alice-entry', 'personal-home-entry', 'personal-office-entry',
      'personal-home-hub-offline']) {
      await expect(alicePage.getByText(description, { exact: true })).toBeVisible();
    }
    await expectAttachmentPreview(alicePage, 'personal-alice-entry', 'personal-receipt.png');
    await expect(alicePage.getByText('shared-office-entry', { exact: true })).toHaveCount(0);
  } finally {
    await aliceContext?.close();
    if (!page.isClosed()) await page.close();
    await Promise.all(peerStores.map((peerStore) => peerStore.close()));
    await store?.close();
    for (const peer of peerNodes) peer.server.closeAllConnections();
    node.server.closeAllConnections();
    await Promise.all(peerNodes.map((peer) => peer.close()));
    await node.close();
    const safePrefix = `${resolve(tmpdir())}${sep}zichan-two-ledger-web-`;
    if (!resolve(dataRoot).startsWith(safePrefix)) throw new Error('unsafe two-ledger test directory');
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
