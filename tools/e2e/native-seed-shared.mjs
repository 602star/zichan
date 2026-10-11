import { newId, localToday, systemTimeZone, unlockAccountEncryptionKey,
  unlockLedgerMemberKeyEnvelope, changeLedgerPassphrase } from '../../packages/core/dist/index.js';
import { loginAccount, httpCommitTransport, syncReplica } from '../../packages/db/dist/index.js';
import { openLedger } from '../../packages/db/dist/node.js';

const url = 'http://127.0.0.1:19343';
const ledgerId = 'ledger-native-shared-0001';
const keyPassword = 'native-profile-member-key-password';
const session = await loginAccount(url, 'owner', 'native-profile-account-password');
const headers = { Authorization: `Bearer ${session.accessToken}` };
const account = await (await fetch(`${url}/api/v4/account/encryption-key`, { headers })).json();
const member = await (await fetch(`${url}/api/v4/ledger/member-envelope`, { headers })).json();
if (!account.record?.envelope || !member.envelope) throw new Error('owner member key unavailable');
const privateKey = await unlockAccountEncryptionKey(keyPassword, account.record.envelope);
let sharedSession;
try { sharedSession = await unlockLedgerMemberKeyEnvelope(privateKey, member.envelope); }
finally { privateKey.fill(0); }
const local = await changeLedgerPassphrase(sharedSession, keyPassword);
const store = await openLedger({ deviceId: 'native-profile-seed-owner' });
try {
  await store.adoptLedgerId(ledgerId);
  const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });
  const initializedAt = new Date().toISOString();
  await store.runInAuditBatch('初始化共享账本测试数据', async (transaction) => {
    const asset = await transaction.assets.put({ ...base(), code: 'CNY', name: '人民币',
      type: 'fiat', decimals: 2, symbol: '¥', isActive: true });
    await transaction.settings.put({ ...base(), baseCurrencyAssetId: asset.id,
      transactionDefaultAssetId: asset.id, investmentCostAssetId: asset.id,
      fixedAssetDefaultCurrencyAssetId: asset.id, gameDefaultSettlementAssetId: asset.id,
      categoryPickerDefaultScope: 'frequent', refundAttributionMode: 'original_date',
      ledgerMode: 'spending', ledgerKind: 'personal', initializedAt,
      defaultLotMethod: 'fifo', asOfDate: localToday(), asOfMode: 'auto_today',
      timezone: systemTimeZone() });
  }, 'system', { undoable: false });
  const transport = httpCommitTransport({ baseUrl: url, token: session.accessToken,
    cryptoSession: local.session, keyEnvelope: local.envelope,
    memberKeyEnvelope: true, requireExistingReplica: true });
  const result = await syncReplica(store, transport, url);
  if (result.pushed < 1) throw new Error('shared initialization did not upload');
  console.log(`seeded ${result.pushed} shared-ledger commit(s)`);
} finally { await store.close(); }
