# 多资产生命周期记账系统 (Multi-Asset Lifecycle Ledger)

账号登录后自动打开服务器托管的账本，并在本设备准备使用同一账号密码的离线访问，详见[账本保护](docs/ledger-protection.md)。


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
  sync-server/   @zichan/sync-server — unified Web + encrypted sync + admin server               ✓ done
  desktop/       @zichan/desktop — Tauri 2 desktop/mobile shell + native SQLite            ✓ done
```

- **SQLite everywhere** via a storage *port* (`LedgerStore`) in the core: `NodeSqliteDriver`
  in tests, `sql.js` + IndexedDB in browsers, and `TauriSqlDriver` + the dedicated Rust SQL bridge on desktop/mobile — one
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
- **`@zichan/sync-server`** — unified server for Web UI, encrypted sync, managed ledger keys, and admin
  metadata APIs. HTTP v3 carries ciphertext commit-DAG envelopes plus encrypted, resumable attachment chunks;
  authorized servers hold escrowed credentials and can decrypt ledger content.
  `npm start -w @zichan/sync-server`.
  [docs/cloud-sync.md](docs/cloud-sync.md).
- **`@zichan/desktop`** — **Tauri 2** desktop shell wrapping the web build; compiles to a native
  binary and supplies the native SQLite/attachment file bridge used by desktop and mobile. Windows v0.1 is a fully portable x64 ZIP:
  ledger, attachments, backups, credentials, WebView state, and the built-in server all live below EXE-sibling `data/` and move together.
  Release mode neither scans nor falls back to AppData. Native sync credentials use Stronghold; mobile adds an optional biometric app lock, receipt capture, barcode scanning, location, and native encrypted-backup sharing. Notifications use the standard Web Notification surface only when the runtime supports it. It can also run a fixed-PC all-in-one server with `npm run server -w @zichan/desktop`.
  In the Tauri desktop shell, **同步 → 服务器管理** can start/stop the local server online;
  browser Web mode shows the server as not enabled and points to the startup command.
  `npm run dev -w @zichan/desktop`. [docs/desktop.md](docs/desktop.md).

## 一键启动 / 关闭

重复点击启动会验证并复用本项目已运行的同配置服务，显示访问地址；不会新建重复进程或重新构建。端口、数据目录等配置不同时会提示冲突。需要加载新代码或新配置时，先运行 `npm stop`，等待停止完成，再运行 `npm start`（开发 Web 与服务器一起启动用 `npm run start:all`）。停止命令会等待服务释放端口与数据句柄，不必手动删除 PID 文件。

- **Windows 双击入口**：`scripts/windows/start-all.cmd` 一键启动开发 Web（5173）和同步/管理服务器（8787）；
  `scripts/windows/start-web.cmd` 只启动开发 Web，`scripts/windows/start-sync-server.cmd` 单独启动已经包含静态 Web 的一体服务器，
  `scripts/windows/setup-webview2-runtime.cmd` 显式准备固定版 WebView2，`scripts/windows/build-desktop.cmd` 构建完全便携 ZIP。失败时窗口会保留诊断信息。
- **Windows 命令行**：`npm start`、`npm run start:all`、`npm run start:server`、`npm run build -w @zichan/desktop`；
  现有多模式清理由 `npm stop` / `npm run stop:server` 提供。
- **POSIX**（WSL / Git Bash / macOS）：`bash scripts/dev/start.sh [web|sync|server|desktop|all]` /
  `bash scripts/dev/stop.sh [web|sync|server|desktop|all]`。

Windows CMD 的依赖检查、数据位置、产物路径和无暂停调用方式见 [scripts/README.md](scripts/README.md)。

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
npm run release:webview2:setup # explicitly download/verify the pinned fixed WebView2 runtime
npm run release:portable # package an already-built Windows executable as the portable ZIP
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
