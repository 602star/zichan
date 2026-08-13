import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_SCHEMA_NAME,
  CURRENT_SCHEMA_VERSION,
  schemaStatements,
} from '../packages/db/dist/index.js';
import { MIGRATIONS_TABLE_SQL } from '../packages/db/dist/schema.js';

export function currentSchemaContract() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    schemaName: CURRENT_SCHEMA_NAME,
    migrationTableSql: MIGRATIONS_TABLE_SQL,
    statements: schemaStatements(),
  };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1]) {
    throw new Error('Usage: node scripts/export-schema-contract.mjs --output <path>');
  }
  return resolve(argv[1]);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const output = parseArgs(process.argv.slice(2));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(currentSchemaContract(), null, 2)}\n`);
  console.log(`schema contract ${CURRENT_SCHEMA_VERSION} exported to ${output}`);
}
