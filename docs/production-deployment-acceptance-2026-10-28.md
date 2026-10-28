# Linux 生产镜像交付验收（2026-10-28）

这份记录只针对开发提交的候选镜像，不表示发布 `1.0.0`。本地 `v0.2.0` 标签未移动，仓库中的版本号未改动。

## 环境与镜像

- 私有 GitHub 仓库：`602star/zichan`；镜像：私有 GHCR `ghcr.io/602star/zichan-sync`。
- 第一个候选源码提交：`e686a60d3abdd646e2f964753ccd9d4fa35eabae`；Actions 作业：[构建与签名记录](https://github.com/602star/zichan/actions/runs/40713231644)。
- 第一个候选 digest：`sha256:403820f798ba1b24a9bebf9c27cf0f1a5b8f815236c02618e3a8a2b6a6153044`，平台 `linux/amd64`。测试机通过 Cosign 核对 GitHub Actions OIDC 身份后从 GHCR 按 digest 拉取。
- 第二个候选源码提交：`92c148a2ce60356c32c56c7e98b37be5c74672c4`；[构建与签名记录](https://github.com/602star/zichan/actions/runs/40716786589)；镜像 digest：`sha256:9c51a58f4ede7e8f397b50e60e3cd2169c4fda7409071addd4ced331f0f421c5`。
- 测试机：`192.168.2.117`，Docker 29.7.1、Compose 5.4.0。原 `zichan-dev` 容器在验收结束后恢复为 healthy。

## 已验证

1. 本地 `npm run release:check`、`npm run build:server`、服务器 TypeScript 类型检查、备份互斥测试与全量 `npm test` 通过；全量测试的最后一个工作区为 101 个文件、701 个测试通过。
2. Linux 测试机使用 [生产 Compose](../apps/sync-server/docker-compose.prod.yml) 及第一个候选 digest 启动**单个**业务容器。`/api/ready`、Web 页面和 Compose 健康检查通过；网络模式为 `host`，服务监听回环地址，容器时区为 `Asia/Shanghai`，`Config.StopTimeout` 为 1800 秒。
3. 从原备份 `pre-fb18930` 恢复到隔离状态目录后，生产部署前后 `server-id` 与 `server.secret` 哈希一致；节点签名密钥与备份一致。原开发容器停机期间才启动恢复副本，避免两个相同身份同时在线。
4. 测试机隔离 Restic 仓库的快照 `5720a5bb`、`25ac7230` 完成 `restic check --read-data`。`ship-backup.sh` 校验数据库、附件和密钥清单后再次运送；`restore-host.sh` 从快照 `25ac7230` 取回、校验并离线恢复，服务器 ID 保持一致。`ship-latest.sh` 首次生成快照 `8fbf1665`，再次执行只报告已运送，没有重复上传。
5. `with-maintenance-lock.sh` 在测试状态为 `waiting` 时允许主机命令，在 `running`、心跳过期、状态文件损坏或锁被占用时拒绝，并在退出后释放锁。生产部署预检拒绝非空但无 `server-id` 的状态目录，也默认拒绝空目录；只有单次显式设置 `ZICHAN_ALLOW_FIRST_BOOT=yes` 才允许全新服务器继续预检。错误 digest 在停止原容器前被拒绝，原开发容器保持 healthy。Restic 凭据检查接受独立目录中的 `0600` 文件，拒绝备份目录内文件和组/其他用户可读文件。
6. `systemd-analyze calendar` 将 `*-*-* 05:00:00 Asia/Shanghai` 解析为北京时间 05:00。容器内 Node 的 `Intl` 时区解析为 `Asia/Shanghai`。
7. 第二个候选镜像从私有 GHCR 按 digest 拉取、验签并以相同隔离状态启动成功；随后切回第一个候选 digest，健康检查、`/api/ready`、Web 页面及服务器 ID 均通过。两次演练结束后，开发容器恢复 healthy。这是**没有 schema 迁移且没有新写入**的旧镜像回退演练，不代表跨版本自动回退已实现。

## 仍需完成

- 隔离 Restic 仓库仍位于**同一测试机**。真实异机目标、空白主机整机恢复、独立保管解密凭据及实际 RPO/RTO 还没有验收。
- 当前没有测试域名，宿主机真实 HTTPS 反向代理与公开入口尚未验收。
- 已验证时区和 timer 解析，但尚未观察一次真实自动备份窗口与次日 05:00 定时运送。
- 真实跨版本迁移、升级任务持久化、Web 一键更新及写入后的回滚边界属于 `1.0.0` 目标，仍未实现；正式版本号待管理员验收决定。
