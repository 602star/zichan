# 项目脚本

脚本按使用场景维护。用户入口应通过根 `package.json` 的 npm 命令，或使用 `windows/` 下可双击的固定任务；不要在仓库根目录增加启动脚本。

## Windows 双击入口

| 脚本 | 用途 | 主要产物或地址 |
|---|---|---|
| `windows/start-all.cmd` | 一键打开开发 Web 与同步服务器两个窗口 | Web `5173` + 同步/管理 `8787` |
| `windows/start-web.cmd` | 启动 Web 开发服务 | `http://127.0.0.1:5173/` |
| `windows/start-sync-server.cmd` | 构建并启动同步 API + Web 管理入口 | `http://127.0.0.1:8787/`，数据位于 `%APPDATA%\ZichanLedger\server` |
| `windows/build-desktop.cmd` | 构建 Web、同步服务资源和 Tauri 安装包 | `apps/desktop/src-tauri/target/release/bundle/` |

这些 CMD 会检查 Node.js 22.3+、npm 和依赖目录；桌面构建还会检查 Rust 与 Perl（vendored OpenSSL/SQLCipher 的 Windows release 构建需要 Perl）。它们不会自动安装依赖、不会抢占端口，也不会结束其他程序。Web 和同步服务器以前台方式运行，使用 `Ctrl+C` 停止。

CMD 默认在结束或失败时暂停，以便双击运行时能看到诊断信息。终端或自动化调用可先设置 `ZICHAN_NO_PAUSE=1`；只验证环境而不执行任务时，同时设置 `ZICHAN_CHECK_ONLY=1`。

同步服务器 CMD 面向可信家庭局域网，会启用局域网 HTTP；不要把 8787 端口直接暴露到公网。公网部署使用 `apps/sync-server/docker-compose.yml` 和 HTTPS 反向代理。

普通使用只需 `start-sync-server.cmd`：它已经在 8787 同时提供构建后的 Web、同步 API 和管理入口。需要 Vite 热更新开发前端时才使用 `start-all.cmd`；它会另外启动 5173，并为两个长驻进程分别保留控制台窗口。

## 目录职责

```text
scripts/
├─ dev/
│  ├─ start.ps1
│  ├─ stop.ps1
│  ├─ start.sh
│  └─ stop.sh
├─ db/
│  └─ export-schema-contract.mjs
├─ release/
│  ├─ check-consistency.mjs
│  ├─ check-consistency.test.mjs
│  ├─ verify-artifacts.mjs
│  ├─ verify-artifacts.test.mjs
│  └─ test-windows-installer.ps1
└─ windows/
   ├─ _check-environment.cmd
   ├─ start-all.cmd
   ├─ start-web.cmd
   ├─ start-sync-server.cmd
   └─ build-desktop.cmd
```

- `dev/`：Windows PowerShell 与 POSIX 的现有多模式开发编排。后续增强 PID 所有权、状态和健康检查时只修改这里。
- `db/`：从唯一的 `@zichan/db` 实现导出 schema，供桌面 SQLCipher 契约测试使用。
- `release/`：版本一致性、安装包/更新清单校验、对应 Node 测试和 Windows 安装烟测。
- `windows/`：面向双击使用的固定任务入口；保持薄包装，不承载复杂编排。

新增脚本必须放入对应职责目录，并同步更新 `package.json`、GitHub Actions 与文档调用点。脚本测试与被测文件保持同目录。
