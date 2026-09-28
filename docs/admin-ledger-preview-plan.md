# 管理员预览用户记账：实施方案

> 状态：**已实施**（阶段 1–6）。服务端内核 `454059a`、管理路由 `238c508`；前端预览页、
> 只读驱动、导航收窄与横幅见本轮改动。**阶段 5 已完成**：管理页附件列表可下载，服务端解密并校验正文，
> 中文文件名通过 `filename*` 返回；退出预览发送 DELETE 并清理附件缓存。
> 实际落地的路由形状与 §4.3 有出入，以代码为准：`POST`/`GET /api/admin/users/:username/preview`、
> `GET /api/admin/previews/:id/backup`、`DELETE /api/admin/previews/:id`。其中 GET 只报告已打开的
> 会话，不会创建（原实现会顺手解密，已修）。预览页地址为 `…/preview?username=…`，账号放查询串。
> 基线：`2120c18`（2026-09-22）。核心链路已用真实服务端 + 真实 HTTP **跑通**（§2.2），不是推理。
>
> 按你的四个决定设计：
> 1. 管理员能看（不只 Owner）
> 2. 默认开，点预览就能看
> 3. 预览数据只放内存，退出后保留几分钟，不落盘
> 4. **用临时链接打开，界面复用现有前端**，不重新开发一套

## 1. 一句话结论

**能做，而且第 4 条正好省掉最大的工作量。**

现有前端 `LedgerApp` 的结构是 `StoreProvider > UndoProvider > App`。只要让 `StoreProvider`
从"本机 IndexedDB"换成"服务器给的一份内存数据"，**整套界面（仪表盘、交易、报表、资产管理）
原样复用**，不用写任何预览页面。

已经验证可行的衔接点：`exportLedger(store) → LedgerBackup（纯 JSON）→ importLedger(store, backup)`。
服务端解出明文后走这条路，前端拿到的就是它本来就认识的数据。

## 2. 技术可行性（已实测）

### 2.1 完整链路

```
服务器自己的材料
  custody.key + sealed_secret   →  托管凭据
  托管凭据 + envelope_json       →  账本密钥包（dataKeys / attachmentSecret）
  密钥包 + sync_server_commits   →  明文提交
  明文提交                       →  重放进内存库
  内存库                         →  exportLedger() → LedgerBackup JSON
  LedgerBackup JSON             →  importLedger()  →  前端直接渲染
```

### 2.2 实测结果（两次独立验证）

**验证一：服务端解密 + 重放 + 便携备份往返**（真实 sync-server + 真实 HTTP + 真实 `managed` 托管，
**只用服务器存储的材料**，不经任何后台接口）：

```
commitRows              = 4
keyringRecovered        = true
applied                 = {"applied":4,"conflicts":0,"skipped":0,"invalid":0,"pending":0}
replayedTransactions    = 1
markerVisibleAfterReplay= true     ← 重放后读得到明文
portableTransactions    = 1        ← exportLedger 出 JSON
renderedTransactions    = 1
markerVisibleAfterImport= true     ← importLedger 后仍读得到
amountPreserved         = true     ← 金额 "42.50" 原样保留
```

**验证二：浏览器驱动（sql.js）也能渲染**——这条直接决定第 4 条能不能落地。
上面的验证用的是 Node 的 `node:sqlite`，而前端跑的是 `sql.js`（WASM），**不是同一个驱动**，
所以单独验了一次：

```
backupTransactions         = 1
browserImportedEntities    = 4
browserRenderedTransactions= 1
browserMarkerVisible       = true   ← SqlJsDriver.open(null) + importLedger 后读得到
browserAmountPreserved     = true
```

**结论：第 4 条要求（复用前端界面）可行**，且浏览器端全程不碰 IndexedDB。

## 3. 架构

### 3.1 临时链接的形态

点「预览」→ 服务端创建一次性预览会话 → 返回链接：

```
/admin/preview/<previewId>
```

前端 `main.tsx` 现有分支是：

```tsx
managementBase !== undefined ? <AdminApp .../> : isTauriRuntime() ? <LedgerApp/> : <WebAccountApp/>
```

预览走 `/admin/preview/...`，属于 `managementBase !== undefined` 分支，所以在 `AdminApp`
里加一个判断即可——**不动 `main.tsx` 的分支逻辑**。

### 3.2 预览会话（内存）

```ts
interface PreviewSession {
  id: string;              // 随机 32 字节，不进 URL 日志
  accountId: string;
  ledgerId: string;
  createdBy: string;       // 管理员账号，用于审计
  reason: string;          // 点预览时填的原因
  createdAt: number;
  expiresAt: number;       // 默认 10 分钟
  lastAccessAt: number;
  ledger: LedgerBackup;    // 已解密的明文，只在内存
}
```

- 存 **进程内 `Map`**，不是数据库、不是磁盘、不是任务表
- 服务端重启 → 全部消失（正确行为）
- 到期由定时器清除，不依赖"用户点了退出"

### 3.3 为什么"保留几分钟"要写成滑动过期

你说的"退出后只保留几分钟"，实现上是**滑动过期**：每次前端拉数据就续期。
但必须给一个**绝对上限**（比如 30 分钟），否则管理员开着一个页面不关，
明文就在内存里无限期躺着。

## 4. 服务端改动

### 4.1 新增 `apps/sync-server/src/ledger-preview.ts`

职责三件：解密、重放、管生命周期。

```ts
export function createPreviewStore(options: {
  custodyKey: Buffer;
  serverId: string;
  ttlMs: number;        // 默认 10 分钟
  maxAbsoluteMs: number;// 默认 30 分钟
  maxSessions: number;  // 默认 5，防内存膨胀
}) {
  const sessions = new Map<string, PreviewSession>();
  // create / get / touch / drop / sweepExpired
}

/** 解密 + 重放，全部在内存。 */
export async function materializeLedger(deps, user: SyncUser): Promise<LedgerBackup> {
  const custody = await deps.store.getLedgerProtection(user.username);
  if (custody?.mode !== 'managed' || !custody.sealedSecret) {
    throw new ServerStoreError('NOT_CUSTODIED', 409, '该账号不是托管模式，服务器无法解密');
  }
  const custodyKeyBytes = readCustodyKeyFile(deps.custodyKeyPath);
  const credential = await openSealedSecret(custodyKeyBytes, `${deps.serverId}:${user.accountId}`,
    custody.sealedSecret);
  const replica = await deps.store.getReplica(user.username);
  if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, '该账号还没有绑定账本');
  const envelope = await deps.store.getKeyEnvelope(user.username, replica.ledgerId);
  const session = await unlockLedgerKeyEnvelope(credential, envelope as never);

  // openLedger() 省略 filename 即 :memory: —— 绝不能传 filename（§8.1）。
  const memory = await openLedger({ deviceId: 'admin-preview' });
  await memory.adoptLedgerId(replica.ledgerId);
  for (let after = 0; ;) {
    const page = await deps.store.listCommits(user.username, after, 500);
    for (const row of page.commits) {
      const commit = await decryptJson<SyncCommitV2>(session, row.encCommit as never, {
        protocol: 2, ledgerId: row.ledgerId, commitId: row.commitId, contentHash: row.contentHash,
      });
      await memory.storeSyncCommit(commit, {
        source: 'remote', sourceReplicaKey: 'preview', state: 'pending', contentHash: row.contentHash,
      });
    }
    if (!page.hasMore) break;
    after = page.nextSeq;
  }
  await applyPendingCommits(memory);
  const backup = await exportLedger(memory);
  await memory.close();
  return backup;
}
```

### 4.2 `AdminRouterDeps` 加 `custodyKey`

现在没接。`admin.ts` 的 `createAdminRouter` 里加：

```ts
custodyKey: Buffer;
preview: PreviewStore;
```

### 4.3 四条路由

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/admin/accounts/:accountId/preview` | 建预览会话，body 带 `reason`；返回 `{ previewId, expiresAt }` |
| `GET` | `/api/admin/previews/:previewId` | 返回该会话的 `LedgerBackup`（滑动续期） |
| `GET` | `/api/admin/previews/:previewId/attachments/:sha256` | 单附件解密下载 |
| `DELETE` | `/api/admin/previews/:previewId` | 主动销毁（点"退出预览"） |

权限：**`auth.role !== 'member'`**（管理员与只读运维都能看，符合你的决定）；
需要 `assertRecentLogin()` 的只有**创建**那一步，续期不要求。

## 5. 前端改动

### 5.1 预览模式下的 `StoreProvider`

不要改 `StoreProvider` 本身（它管着本机存储、自动备份、同步生命周期，改动风险高）。
新增一个**只读提供者**，复用同一套 `Ctx`：

```tsx
// apps/web/src/admin/PreviewLedgerView.tsx
export function PreviewLedgerView({ client, previewId }: Props) {
  const [store, setStore] = useState<SqlLedgerStore | null>(null);
  useEffect(() => {
    void (async () => {
      const backup = await client.request<LedgerBackup>(`/previews/${previewId}`);
      const driver = await SqlJsDriver.open(null);   // 空库，纯内存
      const s = await createLedgerStore(driver);
      await importLedger(s, backup);
      setStore(s);
    })();
  }, [previewId]);
  if (!store) return <Loading />;
  return <PreviewStoreContext.Provider value={readOnlyContext(store)}><App /></PreviewStoreContext.Provider>;
}
```

关键点：
- **`SqlJsDriver.open(null)` + `importLedger`**：这条组合**已实测通过**（§2.2 验证二），
  浏览器端不碰 IndexedDB
- 复用 `App`，界面与用户端完全一致（满足第 4 条）
- 但**必须禁用写操作与后台任务**（§5.2）

> 实现细节：`App` 通过 `useStore()` 读上下文。预览要么复用一个能同时供两种
> Provider 使用的上下文，要么让预览走一个只提供 `store`/`rev`/`bump` 的最小实现。
> 后者更稳——预览不需要 `resetLocalData`、`exitAccount` 这些本机能力。

### 5.2 预览模式必须关掉的东西

`StoreProvider` 现在会做这些事，预览模式**一个都不能跑**：

| 行为 | 位置 | 为什么必须关 |
|---|---|---|
| `maybeAutoBackup` | `store.tsx:581,605` | 会拿管理员的身份去写备份 |
| `installSyncLifecycle` | `App.tsx:319` | 会尝试把预览数据同步回服务器 |
| `runLedgerMaintenance` | `store.tsx:568` | 会改写预览数据 |
| `runDueScheduledTransactions` | `store.tsx:569` | **会凭空生成交易** |
| `recoverAttachmentStorage` | `store.tsx:567` | 会动附件存储 |

这不是"最好关掉"，是**必须关**：不关就会往用户的账本里写东西。
实现上用一个 `readOnly` 标志贯穿，或在预览路径里根本不挂这些 effect。

**写操作拦截**：`SqlDriver` 接口只有 6 个方法（`exec`/`run`/`all`/`get`/`transaction`/`close`），
在 `run`/`exec` 上包一层"预览模式直接抛错"的驱动即可。UI 上按钮该灰就灰，
但**服务端与驱动层都要拦**，不能只靠 UI 灰按钮。

### 5.3 界面提示

预览页顶部常驻一条横幅：

> **只读预览** · 管理员 `<用户名>` 正在查看 `<目标账号>` 的记账 · 本次查看已记录审计 ·
> 剩余 `<N>` 分钟 · [退出预览]

## 6. 附件

附件解密和账本不同：**AAD 绑定用户名**。

```ts
deriveAttachmentCryptoContext(session, { serverId, ledgerId, username })
```

⚠️ **坑**：`sync_users.username` 是 `COLLATE NOCASE`，但 AAD 用的是**客户端提交的原串**。
库里存 `Alice`、用户当时输 `alice`，用库里的拼写复算 `blobId` 会**算出另一个 ID**，
表现为"附件全部找不到"且**不报错**。必须有测试覆盖大小写不一致的情况。

实现分别保留存储命名空间和加密用户名：存储始终使用账号原始拼写；AAD 依次尝试库中原串、
小写形式、打开预览时提供的原串，并兼容密钥包中的历史附件密钥。测试真实构造库内 `Alice`，
分别以 `Alice` / `alice` 加密上传，验证 HTTP 下载正文、中文文件名、缓存头及日志。
服务端未保存任意历史客户端拼写，无法从哈希反推；若曾用其他大小写组合上传，可在预览 URL
的 `username` 参数提供原串后重新打开。未命中时明确提示正文缺失或大小写不符，不返回空成功。

附件下载仍走服务端解密流，前端只负责渲染。**不做 inline 预览**（只给下载），
避免让后台渲染用户的任意文件。

## 7. 审计

| 事件 | 记到哪 |
|---|---|
| 创建预览（含 `reason`） | `log()` + `mutateAdmin` 审计表 |
| 预览到期自动销毁 | `log()` |
| 主动退出预览 | `log()` |

**审计里绝不写解密出来的内容**，只写"谁、看了谁、什么时候、为什么"。

## 8. 三个必须注意的坑

1. **绝不能落明文**：`openLedger(opts)` 把 `opts.filename` 直接传给
   `new NodeSqliteDriver(filename)`，而该构造函数签名是 **`filename = ':memory:'`**（源码已核对）。
   所以**省略 `filename` 才是内存库**；一旦传了路径，服务器磁盘上就多一份用户明文账本。
   预览数据也不进任务表、不进日志、不进备份。
2. **用户名大小写**（§6）：AAD 用原串，DB 用 NOCASE。
3. **分页**：`listCommits` 按 seq 分页，必须循环拉完。只拉第一页 → 账本缺数据 →
   表现为"金额对不上"，比报错难查得多。

## 9. 实施顺序

| 阶段 | 内容 | 可独立验证 |
|---|---|---|
| 1 | `ledger-preview.ts`：解密 + 重放 + 会话生命周期 | 单测：能解出并导出 `LedgerBackup` |
| 2 | 4 条管理路由 + 审计 | 接口测试：权限、过期、销毁 |
| 3 | `AdminApp` 加预览路由 + 只读 `StoreProvider` | 手工：界面与用户端一致 |
| 4 | 写操作拦截（驱动层 + UI） | 单测：预览模式下写操作抛错 |
| 5 | 附件解密下载 + 大小写测试 | 单测：`Alice`/`alice` 两种拼写 |
| 6 | 界面横幅 + 退出预览 | 手工 |

## 10. 明确不做

- 后台 inline 渲染附件（只给下载）
- 批量导出明文
- 预览数据落盘 / 进缓存 / 进任务结果
- 把 `custody.key` 路径写进后台配置
- 用"已切私密模式"当撤回承诺（历史托管凭据仍在）

## 11. 需要确认的一点

你的决定里"**默认开**"我按"任何管理员点预览就能看"实现了（§4.3）。
如果之后要收紧，加一个"按账号开关 + 双人授权"即可，接口形状不用变。

## 12. 阶段 5 验证（2026-09-22）

- `npm test`：1,205 个测试通过。
- `npm run typecheck`、`npm run lint`、`npm run build:server`：通过。
- `admin-preview-attachment.spec.mjs`：使用本机 Chrome，通过真实页面下载中文文件名附件，逐字节校验正文，并确认退出发送 DELETE。
- 附件集成测试涵盖多分块、`Alice` / `alice` AAD、缺失附件、损坏密文、会话关闭和下载途中关闭；正文只在内存解密，响应禁止缓存。

## 13. 交付复验（2026-09-28）

- 收齐阶段 5 与退出预览 DELETE 修复；当前全量测试为 166 个文件、1,209 项通过（core 135、db 175、logger 7、sync-server 292、web 600）。§12 保留此前验证记录。
- 首轮全量测试中，`admin-list-sort` 有一项在 fixture 注册账号时遇到本地服务器连接失败；单独复跑该文件 7 项通过，再完整运行 `npm test` 通过，未修改该测试。
- `npm run typecheck`、`npm run lint`、`npm run build:server`、`npm run release:check`、`git diff --check` 通过。
- 浏览器命令：设置 `PLAYWRIGHT_EXECUTABLE_PATH` 为本机 Chrome 后，运行 `npm run test --prefix tools/e2e -- --config account.config.mjs admin-preview-attachment.spec.mjs admin-ledger-preview.spec.mjs`，3 项通过；已检查附件列表截图。
- 最终全量日志：`.runtime/preview-delivery-tests-final.log`；首次运行、针对性复跑、类型检查、Lint、构建、发布检查和浏览器日志同目录，前缀为 `preview-delivery-`。
- 已更新工作日志，并在 `memory/2026-09-22c.md` 标明旧阶段 5 待办已完成。本批完成代码交付验证，不包含线上部署或桌面发行包重建。
