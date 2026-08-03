# 多资产生命周期记账系统 (Multi-Asset Lifecycle Ledger)

Local-first ledger for the full lifecycle of many asset kinds — fiat, stablecoins,
crypto (with DCA + lot cost basis), game-season economies, and physical items with
per-day/count/km/hour cost — plus everyday income/expense bookkeeping. Built from the design handoff (`资产记账系统.dc.html`) and the design
plan v0.2, with the data model **redesigned** to fix gaps in the plan (see
[`docs/data-model.md`](docs/data-model.md)).

## Architecture (web + desktop + mobile, maximum reuse)

All logic lives in a platform-agnostic TypeScript core; thin UI shells reuse it.

```
packages/
  core/          @zichan/core — data model + all lifecycle calculations (no UI, no I/O)   ✓ done
  logger/        @zichan/logger — structured, leveled, platform-agnostic logging          ✓ done
  db/            @zichan/db — SQLite schema + repository implementing core's storage port  ✓ done
apps/
  web/           @zichan/web — shared React + Vite UI + platform storage selection         ✓ done
  sync-server/   @zichan/sync-server — unified Web + E2E sync + admin server               ✓ done
  desktop/       @zichan/desktop — Tauri 2 desktop/mobile shell + native SQLite            ✓ done
```

- **SQLite everywhere** via a storage *port* (`LedgerStore`) in the core: `NodeSqliteDriver`
  in tests, `sql.js` + IndexedDB in browsers, and `TauriSqlDriver` + `tauri-plugin-sql` on desktop/mobile — one
  schema, one repository. See [docs/db.md](docs/db.md).
- **decimal.js** for all money math — never JS floats on a ledger.
- **Logging**: `@zichan/logger` (ephemeral diagnostics) + an `operation_log` audit table
  (durable product history, separate from sync commits). See [docs/logging.md](docs/logging.md).

## `@zichan/core`

| Module | Responsibility |
|---|---|
| `types.ts` | Entity model v1 (assets, accounts, chains, lots, DCA, games, fixed assets, price marks, attachments, daily transactions) |
| `decimal.ts` | Decimal helpers (precision 40, half-up) |
| `postings.ts` | Balance engine — signed postings are the single source of truth for balances |
| `conversion.ts` | Conversion-chain cost/proceeds tracing (settlement-currency net movement) |
| `lots.ts` | Lot creation + FIFO/LIFO/average/manual sell matching + realized P&L |
| `dca.ts` | DCA report (per-row + cumulative + average cost) |
| `game.ts` | Game-season income/expense/net, per-hour/per-day, reference balance |
| `fixed.ts` | Physical-item invested/net cost, user-entered residual value, usage metrics, consumables, and goals |
| `transaction.ts` | Daily income/expense summaries by category, month, and trend |
| `valuation.ts` | Portfolio valuation, allocation %, unrealized P&L from price marks |

## Other packages

- **`@zichan/db`** — SQLite persistence implementing the core's `LedgerStore` port; a
  declarative table registry generates the schema, every mutation is audited to
  `operation_log`. Includes an application **service layer** (`recordConversion`, `recordSell`,
  `updateConversion`, `voidConversion`/`restoreConversion`, `saveTransaction`,
  `voidTransaction`/`restoreTransaction`, and `exportLedger`/`importLedger` with import preflight), a **doctor**
  (consistency check + cache recompute), and a **sync layer** (atomic commit DAG, aggregate revisions,
  explicit merge commits, and per-replica acknowledgements for N-way relay). [docs/db.md](docs/db.md).
- **`@zichan/logger`** — structured logging with pluggable sinks. [docs/logging.md](docs/logging.md).
- **`@zichan/web`** — React + Vite app: daily transactions, normalized multi-fee conversions, physical-item lifecycle, reports, audit history, management, settings, sync, and server administration +
  3 themes. Browsers use sql.js/IndexedDB; Tauri desktop/mobile use `ledger.sqlite`. Audited add/edit and recoverable voiding, manual
  lot-pick sells, daily income/expense ledgers, DCA reminders, configurable as-of date, charted/PDF reports, attachments, encrypted
  `.zcbak` import/export with preflight + restore rehearsal, automatic local backups, system backup sharing, multi-branch sync conflict box
  with JSON export, tested pure selectors per screen. `npm run dev -w @zichan/web`.
  [docs/web.md](docs/web.md).
- **`@zichan/sync-server`** — unified server for Web UI, **end-to-end-encrypted** sync, and admin
  metadata APIs. HTTP v3 carries ciphertext commit-DAG envelopes plus encrypted, resumable attachment chunks;
  the server cannot read ledger fields, attachment names, plaintext hashes, or file bodies.
  `npm start -w @zichan/sync-server`.
  [docs/cloud-sync.md](docs/cloud-sync.md).
- **`@zichan/desktop`** — **Tauri 2** desktop shell wrapping the web build; compiles to a native
  binary and supplies the native SQLite/attachment file bridge used by desktop and mobile. Native sync credentials use Stronghold; mobile adds an optional biometric app lock, receipt capture, barcode scanning, location, and native encrypted-backup sharing. Notifications use the standard Web Notification surface only when the runtime supports it. It can also run a fixed-PC all-in-one server with `npm run server -w @zichan/desktop`.
  In the Tauri desktop shell, **同步 → 服务器管理** can start/stop the local server online;
  browser Web mode shows the server as not enabled and points to the startup command.
  `npm run dev -w @zichan/desktop`. [docs/desktop.md](docs/desktop.md).

## 一键启动 / 关闭

- **Windows**：双击 `start.cmd`（或 `npm start`）启动 Web，浏览器打开 http://localhost:5173。
  命令行可用 `start.cmd server` 启动常开电脑一体服务，`start.cmd desktop` 启动 Tauri 开发壳。
  双击 `stop.cmd`（或 `npm stop`）会清理 Web + server 端口；也可 `stop.cmd server` 只停 8787。
- **POSIX**（WSL / Git Bash / macOS）：`bash scripts/dev-start.sh [web|sync|server|desktop|all]` /
  `bash scripts/dev-stop.sh [web|sync|server|desktop|all]`。

## Develop

```bash
npm install          # once (Node ≥ 22.3, for node:sqlite)
npm run quality:setup # install isolated ESLint, coverage, and Playwright tools
npm run lint          # TypeScript/React Hooks lint
npm test             # all workspaces (core + db + logger + web)
npm run test:coverage # official Vitest V8 coverage with enforced thresholds
npm run test:e2e      # Playwright: persistence, draft restore, PDF download
npm run typecheck    # tsc --noEmit across workspaces
npm run build        # emit dist for logger + core + db
npm run build:web    # typecheck + optimized, page-split production bundle
npm run dev          # web dev server only
npm run start:desktop # Tauri dev shell
npm run server -w @zichan/desktop  # fixed-PC all-in-one server
npm run start:server # same fixed-PC server through the root startup wrapper
npm run mobile:init:android # one-time Android project generation (requires Android SDK/JDK 17+)
npm run mobile:dev:android  # run the shared Tauri app on Android
```

The full workspace test suite validates core calculations, SQLite migrations and backup round trips,
multi-currency reports, normalized conversion fees, item usage goals, sync, and the real-use workflow.
It checks the prototype's example numbers and corrected figures where the original arithmetic was off;
database tests cover DCA, sells, physical items, game records, daily transactions, and sync conflicts.

A running record of changes is kept in [docs/worklog.md](docs/worklog.md).

## Design source

`资产记账系统.dc.html` (the original read-only prototype) and design plan v0.2 are the
visual starting point. The current application extends that source with complete data-entry,
recovery, audit, sync, reporting, and desktop release workflows.
