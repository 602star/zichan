import type { BaseEntity } from '@zichan/core';
import { NodeSqliteDriver, type OpenLedgerOptions } from '../src/node.js';
import { createLedgerStore } from '../src/repository.js';
import { TABLES, allCols, entityToParams } from '../src/tables.js';

export async function openDiagnosticLedger(options: OpenLedgerOptions = {}) {
  const driver = new NodeSqliteDriver(options.filename);
  const store = await createLedgerStore(driver, options);

  return {
    store,
    rawPut: async (table: keyof typeof TABLES, entity: BaseEntity & Record<string, unknown>) => {
      const spec = TABLES[table];
      const now = new Date().toISOString();
      const stored = {
        ...entity,
        createdAt: entity.createdAt || now,
        updatedAt: entity.updatedAt || now,
        version: entity.version || 1,
        isDeleted: entity.isDeleted ?? false,
      };
      const columns = allCols(spec).map((column) => column.col);
      await driver.run(
        `INSERT OR REPLACE INTO ${spec.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        entityToParams(spec, stored),
      );
    },
  };
}
