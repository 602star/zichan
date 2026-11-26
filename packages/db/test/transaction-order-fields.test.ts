import { describe, expect, it } from 'vitest';
import { newId, type Transaction } from '@zichan/core';
import { createLogger, nullSink } from '@zichan/logger';
import { openLedger } from '../src/node.js';
import { saveTransaction, exportLedger, importLedger } from '../src/services.js';
import { memoryCommitTransport, syncReplica } from '../src/index.js';
import { NodeSqliteDriver } from '../src/drivers/node-sqlite.js';
import { runMigrations, assertCurrentSchema } from '../src/migrations.js';

describe('transaction order fields', () => {
  it.each([130, 131])('upgrades schema %s without resetting transactions and accepts string identifiers', async (version) => {
    const driver = new NodeSqliteDriver(), log = createLogger({ sinks: [nullSink()] });
    try {
      await runMigrations(driver, log);
      await driver.run("INSERT INTO transactions (id, amount, description, order_number) VALUES ('kept', '49.90', '原流水', '000099')");
      if (version === 130) {
        await driver.exec('ALTER TABLE transactions DROP COLUMN order_number');
        await driver.exec('ALTER TABLE transactions DROP COLUMN tracking_number');
      }
      for (const column of ['invoice_number', 'invoice_code', 'invoice_date']) await driver.exec(`ALTER TABLE transactions DROP COLUMN ${column}`);
      await driver.run('UPDATE schema_migrations SET version = ?, name = ?', [version, version === 130 ? 'current_schema_2026_11_16_calendar' : 'current_schema_2026_11_26_order_fields']);
      await runMigrations(driver, log); await assertCurrentSchema(driver);
      expect(await driver.all('SELECT amount, description, order_number, invoice_number FROM transactions')).toEqual([{ amount: '49.90', description: '原流水', order_number: version === 130 ? null : '000099', invoice_number: null }]);
    } finally { await driver.close(); }
  });
  it('preserves order and tracking identifiers through storage, encrypted sync and backup restore', async () => {
    const a = await openLedger({ deviceId: 'order-a' }), b = await openLedger({ deviceId: 'order-b' }), restored = await openLedger();
    try {
      const base = { createdAt: '', updatedAt: '', version: 1, isDeleted: false };
      await a.assets.put({ ...base, id: 'CNY', code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true });
      const tx: Transaction = { ...base, id: newId(), type: 'expense', amount: '49.90', date: '2026-11-25', category: 'food', assetId: 'CNY', orderNumber: '00001234567890', trackingNumber: 'SF00000123456789', invoiceNumber: '00001234567890123456', invoiceCode: '012345678901', invoiceDate: '2026-11-24' };
      await saveTransaction(a, tx);
      const wanted = { orderNumber: tx.orderNumber, trackingNumber: tx.trackingNumber, invoiceNumber: tx.invoiceNumber, invoiceCode: tx.invoiceCode, invoiceDate: tx.invoiceDate };
      expect(await a.transactions.get(tx.id)).toMatchObject(wanted);
      await b.adoptLedgerId(await a.getLedgerId());
      const transport = memoryCommitTransport(); await syncReplica(a, transport, 'order-test'); await syncReplica(b, transport, 'order-test');
      expect(await b.transactions.get(tx.id)).toMatchObject(wanted);
      await importLedger(restored, await exportLedger(a));
      expect(await restored.transactions.get(tx.id)).toMatchObject(wanted);
    } finally { await a.close(); await b.close(); await restored.close(); }
  });
});
