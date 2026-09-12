# 同步提交图设计（Protocol v2）

账号保护遵循[云端托管与私密模式](ledger-protection.md)：托管账号登录后自动解锁，私密账号使用恢复码。下述加密协议两种模式共用，服务器能否解密取决于是否取得托管授权。


同步使用加密的提交 DAG，而不是传最终快照或逐行审计事件。目标是让多设备、
多服务器中的并发修改都可追溯、可中继、可显式合并，并避免金额相关聚合被部分应用。

## 身份模型

- `ledgerId`：一个逻辑账本的永久身份；服务器账户首次绑定后不可静默切换。
- `serverId`：服务器安装身份，换域名或 IP 后仍保持不变。
- `replicaId`：该用户在某台服务器上的提交流身份。
- `streamEpoch`：提交流世代；与 `replicaId` 一起防止错误复用旧游标。
- `deviceId`：产生提交的稳定客户端身份，用于审计和冲突分支说明。

本地确认键由 `serverId + replicaId + streamEpoch + ledgerId` 组成。两个配置若指向同一副本，
客户端会拒绝重复同步。

## 提交与聚合

```ts
SyncCommitV2 {
  protocol: 2;
  ledgerId; commitId; originDeviceId; createdAt;
  parentCommitIds: string[];
  resolvesConflictCommitIds?: string[];
  revisions: SyncRevisionV2[];
}

SyncRevisionV2 {
  revisionId; aggregateType; aggregateId;
  parentRevisionIds: string[];
  op: 'put' | 'delete';
  payload: object | null;
}
```

一笔业务操作只形成一个已封口提交。流水与拆分项是一个 `transaction` 聚合；转换链与全部步骤是
一个 `conversion` 聚合。lot、消耗和转换缓存是可重建派生数据，不作为独立同步真相。批量操作在
审计上下文结束前保持 `sealed=0`，同步遇到未封口提交会拒绝启动，避免推送半笔业务。
批次回调结束（包括抛错）后会封口已经真实提交的部分；若进程在中途退出，下次打开数据库会恢复并
封口残留提交，避免同步永久锁死。使用事务的批次失败时，业务写入和提交图仍整体回滚。

## 本地存储

- `sync_commits` / `sync_revisions`：提交正文、状态和聚合修订。
- `sync_entity_heads` / `sync_ledger_heads`：当前聚合与账本 DAG 头。
- `sync_replica_state` / `sync_replica_acks`：每个服务器副本的游标、头序号和提交确认。
- `sync_conflict_groups` / `sync_conflict_branches`：隔离的冲突提交及所有分支。
- `sync_conflict_resolutions`：人工选择、字段合并或其他设备合并的永久记录。

远端提交先与游标更新一起原子落库，再按依赖顺序应用。父提交未应用时子提交必须等待；提交环、
修订环和不属于提交祖先的修订父节点会标为无效。无法应用的业务快照在事务中回滚并隔离，不会让
整轮同步崩溃。服务器和客户端都按 `commitId + contentHash` 幂等去重；相同 ID 对应不同哈希会被拒绝。

每个远端提交还会生成 `source=remote_sync` 的审计批次，记录来源服务器、副本、提交、设备和应用结果；
远端落库显式禁止再次产生出站修订，避免同步回声。人工合并使用独立的 `conflict_resolution` 批次。

## N 向同步轮次

`syncReplicas()` 把所有启用配置视为一次操作：

1. 连接全部服务器并校验身份与 `ledgerId`。
2. 从全部健康副本分页拉取提交。
3. 按 DAG 依赖应用本地待处理提交。
4. 把本地已知且未确认的提交推到每个健康副本。
5. 再拉取一次并验证连续序号、内容哈希、完整确认集、游标、远端头和待推送数量。
6. 未收敛时继续下一轮，默认最多三轮。

单台服务器失败会被隔离，其他服务器仍继续；但总结果会明确标记未完全收敛。从 S2 拉到的提交
会在同一轮或下一轮重新加密后推给 S1，因此服务器无需互联，也可实现 N 向中继。

## 冲突与合并

修订通过 `parentRevisionIds` 判断祖先关系。无重叠字段的并发修改可做保守三方合并；同字段分歧、
删除与修改并发、缺失父修订都进入冲突组。冲突提交及其后代不会部分写入业务表。

用户可保留本机分支、选择任一远端分支，或逐字段手动合并。解决动作产生新的 merge commit，
其父提交和父修订必须覆盖所有被解决分支，并在 `resolvesConflictCommitIds` 中声明目标。其他设备
收到后会验证祖先关系；伪造或覆盖不完整的声明标为无效，合法声明会自动关闭对应冲突组。

## 服务端协议与加密

- `GET /api/v3/replica`：读取账户副本身份。
- `POST /api/v3/replica/bind`：首次绑定 `ledgerId`。
- `GET/PUT /api/v3/key-envelope`：读取或保存密码包装的账本密钥封套。
- `GET /api/v3/commits?after=<seq>&limit=<n>`：分页拉取密文提交。
- `POST /api/v3/commits`：每批最多 100 条，幂等追加。

HTTP v3 同时提供密文附件对象 API；提交内部仍使用当前 `SyncCommitV2` DAG 信封，两者版本含义不同。

服务器账号密码只用于 OPAQUE 注册与登录。客户端先匿名读取 `/api/health`，固定并核对 `serverId` 与 OPAQUE
服务器公钥，再完成不向服务器发送明文密码的 PAKE 流程；服务器只保存 OPAQUE 注册记录和一次性登录状态。
登录状态绑定来源 IP、短时有效且只能消费一次。登录后使用 15 分钟访问令牌和可轮换的 7 天设备 refresh session，
管理员或用户可撤销单台设备；部署者在独立 `/admin/` 显式创建唯一 Owner，普通注册不会取得管理员权限。
托管凭据或私密恢复码
使用 Argon2id 解锁一个包装的密钥环；密钥环保存随机数据密钥、附件密钥和备份密钥，且只在会话
内解锁。提交使用当前随机数据密钥做 AES-256-GCM，`protocol + ledgerId + commitId + contentHash`
作为 AAD；修改账本密码只重新包装密钥环，轮换数据密钥时保留旧密钥以读取历史提交。

各服务器可以使用不同账号密码，但同一账本共享账本密钥。客户端中继时先解密校验，再针对目标
路由重新加密；未获托管授权的服务器只看到密钥封套、密文和必要路由元数据。获授权的托管服务器具备解密能力，不能声称对其端到端保密。

## 首次加入与恢复

空账户由第一台设备绑定。已有账户若遇到不同 `ledgerId`，客户端绝不自动覆盖：同步页显示远端
账本身份，用户必须输入“替换本机”。客户端先用相应的托管凭据或私密恢复码解锁密钥封套，在隔离的临时数据库中
分页拉取、验证并应用完整提交 DAG，确认收敛后创建本机保护备份；只有这些步骤全部成功，才会在事务中
替换本机账本与设备同步状态并整理附件。密钥采用、附件整理或连接身份持久化失败时恢复原账本、原密钥、
原设备状态和原服务器配置，不再采用“先清空、再重拉”的破坏性流程。常规备份恢复与服务器提交流是
两个独立恢复通道。

完整设备备份携带包装的密钥封套、审计、同步状态和附件正文；使用创建备份时的恢复凭据
预检恢复。本地模式可恢复完整设备状态，账号模式保留当前账号的密钥及身份，只恢复业务内容。可移植备份不接管当前设备的密钥和同步身份，其 merge 不等于独立账本安全合并。

公网 API 必须通过 HTTPS；服务只信任显式配置的反向代理头。为支持官方 Web 连接自建服务器，CORS
允许任意 Web Origin，但跨站不启用 Cookie 凭据，同站采用隔离的 HttpOnly Cookie 会话。跨站只开放明确的方法及 `Content-Type`、`Authorization` 等必要
Header；实际访问控制由 OPAQUE、Bearer 会话、角色检查、设备撤销、持久限流和配额完成。HTTP 只用于
loopback 或私有局域网；HTTPS 页面连接私网 HTTP 仍可能被浏览器混合内容或私有网络策略阻止，此时应使用
可信 HTTPS、服务器自带 Web 或桌面端。

本项目尚未发布，只接受当前提交协议 v2、HTTP/密文协议 v3、加密归档 v4（载荷 v2、账本备份 v7）、
同步服务器 `server_key_custody_v10`（schema 10）和本地账本
`current_schema_2026_09_01_navigation_layout`（schema 116）。旧 PBKDF2/HMAC 认证、旧 Admin Token、旧管理路由、
旧同步连接配置、旧事件端点、旧游标表、快照同步以及开发期旧数据库均不读取或迁移；发现旧开发数据时明确要求重置。
