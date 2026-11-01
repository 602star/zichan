# 仓库协作约定

## 项目结构

本仓库是本地优先多资产账本的 npm 工作区。`packages/core` 放平台无关的数据模型和计算，`packages/db` 放 SQLite 表结构、仓储及同步逻辑，`packages/logger` 放结构化日志。`apps/web` 是 React + Vite 界面，`apps/sync-server` 提供账号、加密同步与附件服务，`apps/desktop` 是 Tauri 壳。测试放在各工作区的 `test/*.test.ts`，文档放在 `docs/`，启动与维护脚本放在 `scripts/`。`dist/`、`target/` 和 `node_modules/` 是生成目录。

## 常用命令

- `npm install`：安装工作区依赖。
- `npm run dev`：启动 Web 开发服务。
- `npm start` / `npm stop`：Windows 开发启动与停止。
- `npm test`：运行各工作区 Vitest 测试。
- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm run build`：构建 `logger`、`core` 和 `db`。
- `npm run dev -w @zichan/desktop`：启动 Tauri 桌面开发壳。
- `npm start -w @zichan/sync-server`：构建并启动同步服务器。

## 代码与测试

使用 TypeScript ESM，遵守 `tsconfig.base.json` 的严格设置。模块保持小而专一；函数和变量使用 camelCase，类型与组件使用 PascalCase，文件名用与功能对应的小写名称。沿用两个空格缩进、单引号和分号。账本金额及资产数量必须使用 `@zichan/core` 的 `decimal.js` 辅助函数，不能用 JavaScript 浮点数直接计算。

测试使用 Vitest，放在受影响工作区的 `test/` 下，以 `*.test.ts` 命名，`describe` 写明行为。账本计算优先使用确定性样例，舍入后断言精确字符串。较大改动前运行 `npm test`；迭代时可运行 `npm test -w @zichan/core` 等定向测试。

## 文档与提交

功能或操作步骤改变时更新[对应主题文档](docs/README.md)，尽量使用中文。重要改动的原因、操作和验证结果继续记录在 `docs/worklog.md`，不把个人 memory 当作项目文档提交。合并过期方案和审查结论；发布变化写入 `docs/release-notes.md`。运行日志、截图和临时数据留在忽略目录。

提交标题用简短祈使句，可带范围，例如 `core: fix FIFO lot matching`。提交保持聚焦，行为变更附相应测试或文档。PR 说明用户可见变化、验证命令和相关文档；界面变化附截图。

## 安全与配置

不要提交 `.env`、`.env.local`、数据库快照、密钥或私人账本导出。同步提交和附件以密文存储与传输；托管服务器持有授权账本的解密凭据。明文账本数据仅留在受控的本地开发存储中。
