# 持久化层 `@zichan/db`

SQLite persistence for the ledger. Implements the core's storage port
([`LedgerStore`](../packages/core/src/storage.ts)) so business logic never touches
SQL. See [`data-model.md`](data-model.md) for the logical model this persists.

## 分层

```
apps ──▶ LedgerStore (core port)
              ▲
              │ implements
        SqlLedgerStore (@zichan/db)
              │ uses
           SqlDriver (port)
        ┌─────┼───────────────┐
 NodeSqliteDriver   SqlJsDriver/WASM   TauriSqlDriver
     (tests)        (browser web)      (desktop/mobile)
```

- **`SqlDriver`** ([driver.ts](../packages/db/src/driver.ts)) — narrow async interface
  (`exec/run/all/get/transaction/close`). One schema, one repository, any SQLite binding.
- **`NodeSqliteDriver`** ([drivers/node-sqlite.ts](../packages/db/src/drivers/node-sqlite.ts)) —
  Node's built-in `node:sqlite`, loaded via `process.getBuiltinModule` so web bundlers
  never try to resolve this new builtin. Node-only; never imported on web.
- **`TauriSqlDriver`** (`apps/web/src/db/tauri-sql-driver.ts`) — asks Rust for the absolute
  `AppData/ledger.sqlite` URL and opens it through `tauri-plugin-sql`; Rust keeps one connection for each
  `BEGIN IMMEDIATE` transaction and uses savepoints for nesting. Browser builds never load it.
- **`SqlLedgerStore`** ([repository.ts](../packages/db/src/repository.ts)) — the port
  implementation: one typed `Collection<T>` per entity + relational helpers.

## 表结构生成

Tables are generated from a **declarative registry** ([tables.ts](../packages/db/src/tables.ts)).
Each BaseEntity table = the 5 common columns (`id`, `created_at`, `updated_at`, `version`,
`is_deleted`) + a compact typed column list. DDL, `INSERT`/`SELECT`, and row⇄entity
mapping all derive from this, so adding a field is a one-line change. Column names are
snake_case of the entity field; enums/amounts store as `TEXT`, counts as `INTEGER`,
booleans as `0/1`.

Hand-written support tables don't follow the BaseEntity shape ([schema.ts](../packages/db/src/schema.ts)):
- **`conversion_steps`** — ordered value objects owned by a chain (`step_order`; no soft-delete).
- **`operation_log`** — durable product audit history; it is not the sync outbox.
- **`audit_batches`** — product-level grouping for batch edits/imports/system repair operations.
- **`ledger_meta`** — stable `ledgerId` for the logical ledger.
- **`sync_commits` / `sync_revisions`** — sealed atomic commits and aggregate revision DAG.
- **`sync_entity_heads` / `sync_ledger_heads`** — current aggregate and ledger graph heads.
- **`sync_replica_state` / `sync_replica_acks`** — per-replica cursor, remote head and commit acknowledgements.
- **`sync_conflict_groups` / `sync_conflict_branches` / `sync_conflict_resolutions`** —
  quarantined branches and durable merge decisions.
- **`attachment_blobs` / `attachment_file_ops`** — local-only CAS state and recoverable file-operation journal.
- **`attachment_replica_blobs`** — per-server upload session, chunk progress and remote object state; never enters ledger sync.
- **`schema_migrations`** — current development schema baseline marker.

Indexes cover the hot query columns (FKs + dates): `game_records.season_id`,
`conversion_steps.chain_id`, `lots.asset_id`, `transactions.date/category/asset_id`, etc.

## 当前 Schema 基线

[migrations.ts](../packages/db/src/migrations.ts) 只创建并接受当前开发基线
`current_schema_2026_08_13_first_run_ledger`（version 115）。项目尚未发布，因此不保留历史升级链：发现旧 marker、旧表、缺列、
多列或额外表时会抛出 `SchemaResetRequiredError`，Web/桌面初始化错误页提供“重置本机开发数据”。Web 端另外会把未加密、
无法解密或数据密钥不匹配的 IndexedDB 快照标记为需要显式重置，并同时提供重试和返回解锁入口。
应用不会自动删除账本，也不会猜测性转换旧结构。若数据库已有业务表但缺少 `schema_migrations`，验证会在写入任何 marker
之前以只读方式拒绝；sql.js 在纯读拒绝后不会导出覆盖 IndexedDB 快照，SQLCipher 探测也不会启用 WAL。真正空库则在同一事务中
建立 marker 和完整当前结构，避免把未知旧库误标为当前版本。当前结构还用部分唯一索引保证最多一个未删除的 `Setting`，备份预检执行同一约束。

### 1.0 迁移兼容边界

产品决策（2026-08-13）：正式数据库迁移框架暂不纳入当前 `0.x` 开发阶段。开发期间仍允许直接提升当前 schema 基线，
旧开发库继续通过导出备份或显式重置处理，不承诺从 version 114、115 或其他开发期 schema 原地升级到后续开发基线。

到 `1.0` 发布准备阶段，再冻结**当时最终确认的 schema** 作为首个长期兼容基线；正式编号迁移只承诺覆盖
`1.0 → 后续版本`。届时再单独审批迁移事务、失败回滚、幂等、未来版本拒绝、跨 sql.js / Node SQLite /
Tauri SQLite 验证和升级测试矩阵。本事项当前状态为“已记录、延期”，不得在其他功能改造中顺带引入半套迁移机制。

每次启动都会逐表、逐列验证当前结构。默认收支分类与物品二级分类属于当前产品资料，由 seed 和
幂等维护任务写入，不再借 schema migration 播种。便携备份只接受完整的 `version=7` 当前格式，
所有实体集合都必须显式存在。

## 平台存储边界

- Browser: `SqlJsDriver` exports `ledger.sqlite` bytes to IndexedDB; attachment bodies and
  thumbnails are content-addressed IndexedDB `Blob` values. Because persistence replaces a whole snapshot, the driver holds an exclusive
  Web Lock for its full lifetime and rejects a second tab instead of allowing two independent in-memory copies to overwrite each other.
- Tauri desktop/mobile: `TauriSqlDriver` stores `ledger.sqlite` under Tauri `AppData`;
  attachment bodies live under `AppData/attachments/{staging,objects,trash,quarantine}` and verified backups under `AppData/backups`.
- Portable `.zcbak` backup embeds attachment bodies without Base64. Export lazily retrieves missing remote bodies; import preflight checks metadata,
  byte length, SHA-256 and thumbnail presence before staging. The ledger import and file journal commit in one SQLite transaction,
  followed by an idempotent atomic promotion; startup completes committed promotions and discards uncommitted staging.
- Backup files use encrypted archive format v3. A small authenticated header is followed by independently authenticated 1 MiB
  AES-GCM frames, so archives can be written/read incrementally instead of materializing all attachments in memory. Each file carries the password-wrapped Argon2id key envelope, so the file plus its ledger passphrase is sufficient on a replacement device. Portable backups contain ledger
  data and attachment bodies; full-device backups additionally contain ledger identity, audit history, sync cursors/conflicts and
  attachment transfer state. Manual and pre-import backups are pinned; automatic backups use hourly/daily/weekly retention.

## Collection API

```ts
interface Collection<T> {
  get(id): Promise<T | null>;
  list(query?): Promise<T[]>;            // equality/order/limit/offset pagination
  listPage(query?): Promise<CursorPage<T>>; // stable keyset pagination
  count(query?): Promise<number>;        // SQL COUNT without loading rows
  put(entity): Promise<T>;               // create or version-CAS update, then audit
  remove(id, expectedVersion): Promise<void>; // required version-CAS tombstone
}
```

`list` supports equality filters on known columns (`{ where: { seasonId: 's1' } }`),
`orderBy`/`desc`, `limit`, and `offset`. Unknown filter fields throw (guards against injection).
`SqlLedgerStore.subscribe()` publishes changed entity types after commit, so each page can invalidate only its scoped snapshot.

设置页的“清理测试流水”使用 `testTransactionCleanupPage()` 作为专用有界读模型：SQLite 只匹配有效流水自身的
`description / merchant / note`，通过 `id` 游标稳定分页，并分批附带命中流水的有效附件。它不依赖页面快照，
也不会为设置页加载整库流水或整库附件。附件正文自检另行在 Web 端以 `Collection.listPage()` 遍历所有有效附件。

总览使用 `dashboardTransactionReadModel()` 读取流水侧数据：SQL 按资产聚合全部有效过账、按所选报表日期聚合收支，
并只返回实际发生日在区间内的最近 6 条流水作为动态候选。聚合保留原始十进制字符串数组，由 Web 端使用
`decimal.js` 求和和折算；账户类型为 `other` 的期初/权益过账继续排除。Dashboard 页面快照因此无需加载全部
`transactions / transaction_splits / refund_allocations`。

`transactionBrowsePage()` 的金额上下限和高级筛选不会把金额 `CAST AS REAL`，也不会先转成 JavaScript
`Number`。仓储层把有限十进制规范化为“十进制指数 + 有效数字”的 SQLite 可比较键，因此大额、小数和科学计数法
都按 `decimal.js` 的精确值筛选；非有限值或超出 SQLite 整数指数范围的输入会显式拒绝，而不是静默错筛。

`put` updates with `WHERE id=? AND version=?`; zero affected rows raise `ConcurrencyError`, so a stale tab cannot
overwrite a newer edit. It then bumps `version` and preserves the original `createdAt`. User-facing categories,
accounts, payees and physical-item categories never call `remove`: `archiveMasterData` preserves references, while
`mergeMasterData` migrates references transactionally and records the destination. Conversion steps are managed with their chain via
`saveChainWithSteps(chain, steps)` (atomic: upserts the chain, replaces its steps) and
read back with `getChainWithSteps(chainId)`.

## 事务与落盘一致性

每个驱动用 FIFO 队列串行化顶层查询、写入、关闭和事务，避免用户操作与后台同步同时进入同一
SQLite 事务。`transaction()` 回调必须使用传入的连接绑定作用域；作用域内再次开启事务会创建
savepoint：

```ts
await store.transaction(async (transaction) => {
  await transaction.transactions.put(next);
  await transaction.scheduledTransactions.put(schedule);
});
```

Collection 的旧值读取、实体写入和审计日志写入位于同一事务。`withAuditContext()` 同样返回隔离
store，重叠的批量任务不会共享 batch id。浏览器驱动只在顶层事务提交后导出 sql.js 字节，并等待
IndexedDB 写完后再结束调用；原生 Tauri 事务则由 Rust 侧绑定连接并提交 `ledger.sqlite`。

## 操作日志 Operation log（产品审计）

Every mutation writes one `operation_log` row: `{ at, deviceId, entityType, entityId,
op(create|update|delete), version, payload(JSON snapshot), beforePayload, afterPayload,
changedKeys, diffJson, batchId, source, actorName, summary }`. This is the **audit trail**
and is deliberately separate from sync commits. Query it with `store.operationLog({ entityType, entityId, op,
batchId, source, since, until, limit, desc })`; `since` is inclusive and `until` is exclusive.
`listAuditBatches()` and `listConflictResolutions()` accept the same `since` / `until` window,
so the history page filters in SQLite instead of loading an arbitrary client-side row cap.

Batch operations use `createAuditBatch()` + `withAuditContext({ batchId })`, so dozens of
entity changes can appear as one product-level action in the UI while still preserving every
row-level diff. Commit-DAG conflict decisions are recorded in `sync_conflict_resolutions` by
`resolveConflictGroup()` and reference the merge commit that closed the branches.

Applying a remote commit uses `source=remote_sync` and suppresses creation of another outbound revision. Its audit batch
records the source commit/server/replica plus applied, skipped and conflicted counts. Conflict decisions use a separate
`conflict_resolution` batch, so History can explain both the incoming change and the user's resolution.

Business dates use `YYYY-MM-DD` local calendar days with inclusive `from` / `to` bounds.
Historical valuation selects the latest price mark whose date is not later than the record or
report date; a future mark is never backfilled into an earlier transaction, conversion, game record,
or fixed-asset report.

## 应用服务层（use-cases）

`src/services.ts` 把「核心计算 + 持久化」封成可复用操作，UI 和 seed 都调用它，业务逻辑
只有一份：

- **`recordConversion(store, {chain, steps})`** —— 保存规范化成交本金/毛额与多条费用，按实际账户实扣/实收回填派生缓存；
  对 buy/dca 按最终净到账自动建 lot，并同时保存原生付款数量与统一投资记账币种成本。
- **`recordSell(store, {chain, steps, method, selectedLotIds?})`** —— 保存卖出链路，用
  `matchSell` 按 FIFO/LIFO/平均/手动 匹配开放 lot，写 `lot_consumptions`、更新 lot 剩余量、
  回填链路的回收额与已实现盈亏。被卖数量包含第一步从来源资产扣除的手续费。
- **`updateConversion` / `voidConversion` / `restoreConversion`** —— 编辑或反向转换后，从受影响日期起按顺序
  重建全部 lot、卖出消耗和链路缓存；历史持仓不足会让整笔操作回滚。转换没有硬删除产品路径。
- **`saveTransactionAggregate` / `voidTransaction` / `restoreTransaction`** —— 原子保存流水、精确拆分和退款分配；
  分类必须是对应收支类型的启用叶子，拆分合计必须精确相等，账户/转账/币种/时间快照必须有效。退款创建时冻结原日期、
  原金额、分类路径和分配比例，后续编辑原支出不会改写历史退款报表。更新使用 `version` CAS；对账状态只由关闭的
  `reconciliation_sessions` 和 `reconciliation_items` 推导，持久化状态仅允许 `pending/cleared`。
- **`previewMasterDataChange` / `archiveMasterData` / `mergeMasterData`** —— 预览引用影响，归档主数据，或在一个审计事务中迁移引用并合并；
  已关闭对账账户、跨收支类型分类、一级/二级分类错层等危险合并会被拒绝。
- **`saveFixedAssetAcquisition` / `saveFixedAssetEvent` / `saveFixedAssetConsumable`** —— 购买、维修、升级、出售和耗材统一使用
  “仅登记 / 关联已有流水 / 同时创建流水”三种模式。`fixed_asset_cashflow_links` 一对一冻结方向、来源金额、记账币种金额、
  实际汇率和流水所有权；同一流水不得超额分配，删除来源时仅自动作废由该来源创建的流水。
- **`previewReconciliation` / `closeReconciliation` / `undoLatestReconciliation`** —— 以最近账单期末余额为期初，
  按账户分录逐笔勾选本期已清算流水，只读计算差额；差额只能继续核对或生成不进入收支报表的余额调整。`reconciliation_items` 固化每期明细，且只能从最新一期逆序撤销。
- **`materializeScheduledTransaction` / `runDueScheduledTransactions`** —— 从原始日期生成日/周/月/年周期，
  支持月末锚点、IANA 时区、漏期全补或只补最近一期；`scheduled_executions` 除确定性 ID 外，还用数据库唯一约束、
  有时限的原子占用和所有者令牌 CAS 协调多个标签页或实例。占用过期后可接管，迟到的失败结果不能覆盖另一实例已完成的成功结果；
  执行记录同时保留执行时间、失败原因、重试次数和下次重试时间。`previewScheduledBacklog` 与 `retryScheduledExecution` 提供积压预览和人工重试。
- **`saveGameRecordAggregate` / `deleteGameRecord` / `restoreDeletedGameRecord`** —— 游戏结算和手续费统一为仅登记、关联已有流水或创建流水；资金关联冻结方向、币种、金额和所有权，删除/撤销使用 CAS 补偿命令。
- **`exportLedger(store)` / `preflightImport(data)` / `validateLedgerBackup(data)` /
  `importLedger(store, backup)`** —— 构造和校验全量实体（含链路步骤、含软删）的内部结构化载荷；
  用户文件由上层封装为加密 `.zcbak`，不直接暴露明文 JSON。
  预检会校验版本、必需数组、重复 ID、全部流水枚举、链路步骤、发生时间、精确拆分、冻结退款和物品资金快照；硬错误拒绝导入，warning 用于人工确认。
  导入是 upsert 合并；干净恢复请导入到空库。
- **`importTransactions(store, {transactions})` / `monthlyTransactionSummary(store, month, assetId?)`**
  —— 日常流水批量导入（同日期/类型/分类/金额/资产/账户/描述/商户去重）和月度收入/支出/分类汇总；导入会先处理原支出，再处理退款，并把被去重原支出的导入 ID 映射到现有 ID。转账不计入收支，退款作为负支出并遵循设置的统计归属日期。

记账增强实体（`categories`、`payees`、`transaction_splits`、`transaction_saved_views`、`budget_categories`、
`scheduled_transactions`、`scheduled_executions`、`reconciliation_sessions`、`reconciliation_items`）都走同一套 `Collection`、操作日志、
备份和提交图同步路径。

物品资产实体（分类、事件、用量指标/记录、耗材、目标、带用途的附件）也全部进入同一备份、预检、
审计和 N 向同步路径。转换步骤直接使用多手续费 `fees_json`，物品直接使用二级分类和用户输入的
当前残值，预算在创建时固定币种，并按 `none / positive_only / signed` 逐月计算结转；记账分类选择器直接保存当前显示范围。

测试：`test/services.test.ts` —— 建 lot、FIFO 卖出闭环（消耗+剩余+已实现回填）、
导出→导入到新库的往返一致、拒绝不支持的备份版本、预检摘要、重复 ID、缺失引用 warning 和日常流水服务。

## 数据自检 doctor（`src/doctor.ts`）

派生缓存（`lot.remainingAmount/status`、`chain.totalBaseCost/Proceeds/realized/…`）是反规范化的，
doctor 用「真相」（steps + consumptions）重算来校验/修复：

- **`checkConsistency(store)`** → 问题列表：lot 剩余量对不上、超卖、孤儿消耗、链路缓存过期、转换费用口径、发生时间、引用/分类/精确拆分、冻结退款分配、物品资金关联、游戏归属与附件正文问题。
- **`recomputeCaches(store)`** → 重算并回写所有 lot 剩余量/状态、链路的 cost/proceeds/realized 缓存。

测试 `test/doctor.test.ts`（8）：健康账本、篡改 lot 后检出并修复、卖出 realized 重建、
引用/必填/状态错误、退款口径，以及 ULID 不能被误当作金额等回归场景。

## 同步 sync

### 提交 DAG（`src/event-sync.ts`）

每次本地业务写入同时生成一个 `SyncCommitV2`。普通实体各自作为聚合；流水连同拆分项、转换链连同
步骤分别组成原子聚合。lot、消耗和转换缓存由已同步转换重建，不独立传播。批量操作的提交在审计
上下文成功结束后才封口，未封口时同步会拒绝运行。
异常中断留下的本地未封口提交会在下次数据库初始化时恢复封口；事务回滚产生不了残留提交。

- `pullReplica()` 先把密文解出的提交、确认和游标原子写入本地，再返回成功。
- 拉取必须是连续服务器序号且内容哈希一致；推送必须收到同一批全部 ID、哈希和有效序号的确认。
- `applyPendingCommits()` 按提交父节点与修订父节点排序；可证明无重叠的字段做保守三方合并。
- 同字段分歧、删除/修改分歧或缺失依赖形成冲突组；整笔提交及后代保持隔离，不部分修改业务表。
- `resolveConflictGroup()` 产生覆盖所有分支的 merge commit。其他设备验证祖先关系后自动关闭同一冲突。
- `pushReplica()` 只发送已封口且该副本未确认的提交，按内容哈希幂等确认。
- `syncReplicas()` 统一执行 pull-all、apply、push-all、re-pull 和收敛校验；健康服务器不受单点故障阻塞。
- 传输实现为 `memoryCommitTransport()`（测试）和 `httpCommitTransport()`（通过 HTTP v3 API 传递 AES-GCM E2E 的 v2 提交信封，连接
  [`@zichan/sync-server`](cloud-sync.md)）。

附件正文不进入提交 DAG。`attachment-sync.ts` 在提交收敛后按服务器分别派生 HMAC 对象 ID 和 AES-GCM 密钥，
以 4 MiB 分块断点上传；缩略图自动补齐，正文按查看/导出或服务器中继需求下载。删除先进入本机和远端回收区，
开放冲突分支中的附件引用同样受保护。

整库快照、旧事件端点和 LWW 状态同步已删除；备份只负责导入、精确恢复和恢复演练。
完整协议、身份与冲突规则见 [`event-sync-design.md`](event-sync-design.md)。测试覆盖单服务器收敛、
两服务器 N 向中继、原子提交、后代隔离、显式合并、远端自动关冲突、账本身份拒绝及确认后换账本。

## 用法

```ts
import { openLedger } from '@zichan/db/node';           // node/desktop
const store = await openLedger({ filename: 'ledger.db', deviceId: 'laptop-1' });

await store.assets.put({ id, code: 'BTC', name: 'Bitcoin', type: 'crypto',
  decimals: 8, isActive: true, createdAt: '', updatedAt: '', version: 1, isDeleted: false });

const chain = await store.getChainWithSteps(chainId);   // → feed to @zichan/core traceChain(...)
const history = await store.operationLog({ entityType: 'asset', desc: true, limit: 50 });
await store.close();
```

On web, construct `SqlLedgerStore` with `SqlJsDriver`; exported SQLite bytes persist in
IndexedDB. Tauri uses `TauriSqlDriver` against `AppData/ledger.sqlite`; repository behavior is unchanged.

## 测试

`npm test -w @zichan/db` — covers CRUD + version/timestamp semantics, soft-delete filtering,
`where` guards, operation log, commit-DAG sync, doctor, service-layer conversion/sell flows, and
file-backed persistence across a reopen. Transaction tests cover CRUD/entity tags, duplicate import,
monthly summaries, transfer/split/budget/schedule/reconciliation persistence, backup/import, and local state sync. The real workflow test exercises add asset, DCA,
sell, fixed asset, game record, consistency check, and a critical sync conflict.
