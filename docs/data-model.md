# 数据模型 v1（重设计）

本文件是对计划书 v0.2 §27 数据库设计的**重新设计**。目标：补齐缺失的表、消除口径歧义、保证财务计算可复现。UI 只读原型（`资产记账系统.dc.html`）展示的数值口径以本文件为准。

对应实现：`packages/core/src/types.ts`（实体类型）+ 各计算模块。

---

## 0. 全局约定（Conventions）

这些约定是整套账本正确性的地基，计划书里没有明确，这里一次性钉死。

### 0.1 金额用十进制字符串存储，用 decimal.js 运算
- 所有金额/数量字段在实体里都是 `string`（十进制字符串，如 `"0.00331700"`）。
- 运算一律走 `packages/core/src/decimal.ts` 的 `D()`（decimal.js，precision 40，ROUND_HALF_UP）。
- **绝不**用 JS `number` 做钱的加减乘除（浮点会漂）。
- 每个资产有自己的 `decimals`（BTC=8，法币=2，USDT=6，游戏币按需），显示时按资产精度四舍五入。

### 0.2 金额存正数，方向由「过账」推导
- 实体里的 `amount` 存**正数量级**（magnitude）。
- 余额不直接读实体，而是由实体**生成过账（postings）**，每条 posting 带符号（`+` 入 / `−` 出）。见 §2。
- 好处：手续费、换汇、双向流水的方向不再靠约定俗成，而是显式规则，杜绝符号 bug。

### 0.3 手续费口径（关键，计划书含糊）
每一步换算：
- `fromAmount` 固定保存**成交本金**，`toAmount` 固定保存扣费前的**成交毛额**。
- 用户可把来源输入解释为“成交本金”或“账户实扣”，把目标输入解释为“成交毛额”或“实际到账”；保存前统一归一化。
- `fees[]` 支持多条费用，每条明确 `source_included`、`source_extra`、`target_deducted` 或 `third_asset_extra`，并保存资产、数量、账户和记账币种折算。
- `referenceRate` 只保存用户输入的市场参考率；成交率 = 毛额 / 本金，有效率 = 实收 / 实扣，均从真实金额派生。

**余额过账**（§2）：
- 来源账户借记“本金 + 来源费用”。
- 目标账户贷记“毛额 − 目标费用”。
- 第三资产费用从其指定账户独立借记。

如此手续费**只被扣一次**，不会「余额里扣一遍、成本里又扣一遍」。

### 0.4 成本 / 收益追溯 = 追「结算币种的真实进出」
- **买入/定投链路总成本** `totalBaseCost` = 该链路中**结算币种的净流出**
  = Σ来源账户实扣(fromAsset==base) + Σ第三资产费用(asset==base) − Σ目标账户实收(toAsset==base)。
- **卖出链路总回收** `totalBaseProceeds` = 结算币种的净流入
  = 上式净流出的相反数；目标费用已经体现在实收、来源费用已经体现在实扣中。
- **中间资产（如 USDT）上的手续费不再重复加进成本**：它已经体现在真实链路流量中；链路外第三资产费用按录入时折算计入。
- `totalFeesInBase`（所有手续费折算 base 之和）**单独**作为报表「总手续费」列展示，不回灌成本。
- 链路不经过投资记账币种时，必须保存交易当时的 `bookValueInBase`；之后修改默认币种不会重算历史成本。
- Lot 同时保留实际付款资产/数量和统一投资记账币种成本；买入按最终实收建仓，卖出来源费用同时消耗 Lot。

### 0.5 派生值是缓存，不是真相
`ConversionChain.totalBaseCost` / `realizedGainLoss`、`Lot.remainingAmount` 等都是**派生缓存**，随底层步骤/配对变化重算。真相是 steps + lot consumptions。导入/校验时以重算为准。

### 0.6 日期与天数
- `date` 类字段存 `YYYY-MM-DD`（本地日历日）。
- 流水和资产转换同时保存 `timePrecision`、原始 IANA `timezone`、`occurredAtUtc`、`utcOffsetMinutes` 和 DST 歧义选择；
  “仅日期”不会被伪造为某个 UTC 时刻，分钟/秒精度则可在跨设备后还原同一瞬间。
- 持有天数 / 赛季天数 = `到期日(或今天) − 起始日` 的日历天数，**含头不含尾**（同日=1 天，避免除零）。
- `createdAt`/`updatedAt` 存 ISO-8601 UTC 字符串。

### 0.7 软删除、审计与同步
`isDeleted: boolean`、`createdAt`、`updatedAt`、`version:int` 属于每个实体；`version` 是本地乐观版本和
审计信息，不承担跨设备因果判断。`operation_log` 只保存产品操作历史。

跨设备因果关系由独立的 `SyncCommitV2` 与聚合 `revisionId / parentRevisionIds` 表达。远端提交先进入
同步图，再静默应用到当前实体表；流水与拆分、转换与步骤作为原子聚合，派生 lot/消耗由转换重建。
详细规则见 [`event-sync-design.md`](event-sync-design.md)。

---

## 1. 实体总览

| 实体 | 作用 | 计划书对应 | 状态 |
|---|---|---|---|
| `Asset` | 资产主数据（法币/稳定币/加密/游戏/固定） | **缺** | 新增 |
| `Account` | 账户/钱包/交易所/平台 | **缺** | 新增 |
| `Setting` | 全局报表币种、各模块默认币种、记账模式 | 隐含 | 新增 |
| `ConversionChain` | 一次换算（单步或多步），统一 §7 与 §27.7 | §7/§27.7 | 合并 |
| `ConversionStep` | 换算的一步 | §9/§27.8 | 保留 |
| `Lot` | 加密资产批次成本 | §12（仅散文） | 补 DDL |
| `LotConsumption` | 卖出配对（哪笔卖消耗了哪个 Lot） | **缺** | 新增 |
| `PriceMark` | 价格/汇率快照（现价、FX） | **缺** | 新增 |
| `DcaPlan` | 定投计划 | §27.5 | 保留 |
| `DcaExecution` | 定投执行 | §27.6 | 保留（挂 chain） |
| `Game` | 游戏 | §27.1 | 保留 |
| `GameAccount` | 游戏账号 | §27.2 | 保留 |
| `GameSeason` | 赛季 | §27.3 | 保留 |
| `GameRecord` | 赛季记录流 | §27.4 | 保留 |
| `FixedAsset` / `FixedAssetCategory` | 物品资料与一级/二级分类 | §16（仅散文） | 扩展 |
| `FixedAssetEvent` | 购买、启用、维修、残值、卖出、报废、清退、赠出 | §16（仅散文） | 扩展 |
| `FixedAssetCashflowLink` | 生命周期事件/耗材与资金流水之间的一对一冻结金额、方向、汇率和所有权 | 新需求 | 新增 |
| `FixedAssetUsageMetric` / `FixedAssetUsageLog` | 次数、公里、小时、自定义用量 | 新需求 | 新增 |
| `FixedAssetConsumable` | 滤芯等耗材寿命与提醒 | 新需求 | 新增 |
| `FixedAssetGoal` | 冻结成本基数的单位成本/使用量目标 | 新需求 | 新增 |
| `Category` | 日常收支分类（支持自定义/预算） | 新需求 | 新增 |
| `TransactionTag` | 标签实体与分组（项目/人/地点/报销/游戏） | 新需求 | 新增 |
| `TransactionLocation` | 交易地点文本/经纬度占位 | 新需求 | 新增 |
| `TransactionTemplate` | 快记模板（午餐/房租/工资/订阅） | 新需求 | 新增 |
| `TransactionSavedView` | 保存的流水筛选/高级查询（JSON 条件） | 新需求 | 新增 |
| `Payee` | 商户/收付款方与默认分类记忆 | 新需求 | 新增 |
| `Transaction` | 日常收入/支出/退款/转账流水，支持可恢复作废 | 新需求 | 新增 |
| `TransactionSplit` | 一笔流水拆分到多个分类 | 新需求 | 新增 |
| `RefundAllocation` | 退款创建时冻结的原单分类、拆分、金额与币种归属 | 新需求 | 新增 |
| `BudgetCategory` | 月度分类预算（冻结创建时币种） | 新需求 | 新增 |
| `ScheduledTransaction` | 定期收入/支出/转账账单 | 新需求 | 新增 |
| `ReconciliationSession` | 账户对账会话 | 新需求 | 新增 |

---

## 2. 余额引擎（Postings）

单一真相：任何影响余额的实体都生成一组 `Posting`：

```
Posting { assetId, accountId?, amount(带符号), source: {kind, id}, date }
```

- `ConversionStep` → 见 §0.3 的过账规则。
- `GameRecord`（结算腿）→ 结算资产按类型 +/−，手续费独立借。游戏币本身**不过账到余额引擎**（§3.3 记录流，参考余额单独算）。
- `FixedAssetEvent` / `FixedAssetConsumable` 本身不直接生成 Posting；购买、维修、升级、耗材和出售通过唯一关联的
  `Transaction` 形成现金流，避免物品成本和流水重复过账。残值、报废、清退和用量不产生现金流。
- `Transaction` → 日常收入按 `+amount`、日常支出按 `-amount`、退款按 `+amount` 回到账户并以 `-refundAppliedAmount` 冲减支出；转账按转出账户 `-amount`、转入账户 `+transferAmount`，且不计入收入/支出。作废记录不产生过账。

`balances(postings)` 聚合出 `{assetId, accountId?} → 净额`。计划书 §28「余额 = 收入 − 支出 − 手续费」是本引擎的特例。

---

## 3. 三类资产的不同模型（呼应计划书 §2、§34）

1. **法币 / 加密（严格）**：走余额引擎 + Lot 成本 + 换算链路。BTC/ETH 启用 Lot 与 FIFO/手动配对。
2. **游戏币（记录流）**：`GameRecord` 不做库存校验，允许卖>买、允许负参考余额；只按 游戏/账号/赛季 统计投入产出回收。
3. **物品资产（生命周期）**：累计投入与用户输入的当前残值分开；不自动折旧。除按天外，还可按次数、公里、小时或自定义单位计算成本，目标创建后冻结成本基数。购买、维修、升级、耗材和出售都必须明确为仅登记、关联已有流水或同时创建流水，避免遗漏或重复现金流。
4. **日常收支（生活账本）**：`Setting.ledgerMode` 默认 `'spending'`，产品层记录收入、支出与退款；切到 `'accounts'` 或 `'assets'` 后才启用账户转账、状态（待确认/已清算）和 `ReconciliationSession`。退款通过 `refundForId` 关联有效原支出，以 `refundAppliedAmount/refundAppliedAssetId` 冻结统计冲减口径；`RefundAllocation` 冻结创建时的分类路径和拆分比例。`Setting.refundAttributionMode` 决定回冲原日期或计入退款日期。`recordState` 提供可恢复作废。`Transaction` 还记录日期、时间、时区、二级分类、地点、实体标签、文本备注和附件；`TransactionSplit` 必须精确合计到流水金额；`Category` 支持一级/二级分类和预算；每条 `BudgetCategory` 保存自身 `assetId`，避免默认币种变化后历史预算被重新解释；`TransactionTemplate` 负责快记；`TransactionSavedView` 保存普通筛选 + 高级 AND/OR 查询 JSON；`ScheduledTransaction` 负责固定账单。

---

## 4. 关键计算（实现见对应模块）

- `postings.ts` — 余额引擎（§2）。
- `conversion.ts` — 链路成本/回收追溯（§0.4）。
- `lots.ts` — Lot 生成 + FIFO/LIFO/手动 卖出配对 + 已实现盈亏。
- `dca.ts` — 定投报表（每次+累计+均价）。
- `game.ts` — 赛季收入/支出/净收益/每小时/每日、参考余额。
- `fixed.ts` — 累计投入、净使用成本、按天/次/公里/小时成本、目标进度和耗材提醒。
- `transaction.ts` — 日常收支按分类、月份、趋势汇总。
- `valuation.ts` — 用 `PriceMark` 的最新币对构建可逆汇率图，支持直接、反向和最短跨币种路径，再折算净资产、配置占比、成本和未实现盈亏。
