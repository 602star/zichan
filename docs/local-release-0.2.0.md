# 0.2.0 本地 Docker/Web 发布包

本次只生成本地归档，不发布到远程 Git 仓库、镜像仓库或在线 Release。源码归档包含 Docker 构建所需的 npm 工作区、锁文件、Dockerfile、Compose 和文档；运行包包含已打包的 `server.mjs`、`maintenance.mjs` 与 Web 静态资源。运行包需要目标机提供 Node.js 22.3 或更高版本；生产 Docker 部署使用源码归档在 Linux 主机上构建镜像。

在 Linux 主机上先用旁车文件核对源码归档的 SHA-256，然后解压，进入 `zichan-0.2.0/apps/sync-server` 执行 `docker compose up -d --build --remove-orphans`。Compose 只运行一个业务容器，服务通过宿主机网络监听 `127.0.0.1:8787`；HTTPS 反向代理须在宿主机运行，保留公共 Host 并覆盖 `X-Forwarded-Proto: https`。首次启动在持久数据卷生成服务器身份和密钥；后续启动必须复用同一个卷。公网只开放 443。备份与恢复操作见 [云同步部署说明](cloud-sync.md)。

发布基线：服务器 schema 27、本地账本 schema 127、同步协议 v3。旧开发数据目录没有自动迁移承诺。下一次计划版本为 `1.0.0`，其生产部署和 Web 一键更新方案见 [1.0 升级方案](production-upgrade-1.0.md)。
