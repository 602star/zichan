# 日志 `@zichan/logger`

A tiny structured, leveled logger with pluggable sinks. Platform-agnostic (no Node/DOM
deps — reads `console` off `globalThis`), so the same logger runs in web, desktop and
mobile shells.

## 概念

- **Levels**: `trace < debug < info < warn < error < silent`. Records below the configured
  level are dropped before reaching sinks.
- **Structured records**: `{ time, level, msg, scope?, fields?, err? }` — never bare strings,
  so logs are queryable/greppable and machine-readable.
- **Sinks**: where records go. A logger can fan out to several.
- **Child loggers**: `log.child('scope', fields)` composes a dotted scope
  (`db.repository`) and merges default fields (e.g. `deviceId`). Children share the parent's
  live level box, so `root.setLevel('error')` affects existing children too.

## Sinks

| Sink | Use |
|---|---|
| `consoleSink(out?)` | human-readable dev output |
| `jsonSink(write)` | one JSON object per line — files / log shippers |
| `memorySink(store?, capacity = 1000)` | retain the newest records, discarding older entries at capacity |
| `nullSink()` | drop everything — the **default for libraries** so they're silent unless wired |

## 约定

日志 sink 抛出的同步异常会被隔离，不会阻止其他 sink 或中断账本事务。需要持久化可靠性的业务审计仍写入数据库，不依赖诊断日志。内存 sink 容量必须是正整数。

- **Libraries default to `nullSink`.** `@zichan/db` logs nothing until an app passes a
  logger — no surprise console spam. Apps decide sinks + level.
- **Log at the boundary, not in pure calculations.** `@zichan/core` calc modules don't log;
  they return values. Persistence/IO (`@zichan/db`) logs `debug` per mutation, `info` per
  migration.
- **Put identifiers in `fields`, not the message.** `log.debug('put', { table, id, version })`,
  not `log.debug('put assets a1 v2')`.
- **Errors go through `error(msg, err)`** so the stack is serialized into `record.err`.

## 用法

```ts
import { createLogger, consoleSink } from '@zichan/logger';
import { openLedger } from '@zichan/db/node';

const log = createLogger({ level: 'debug', sinks: [consoleSink()], fields: { app: 'desktop' } });
const store = await openLedger({ logger: log, deviceId: 'laptop-1' });
// → db mutations now emit: <time> DEBUG [db.repository] put {"table":"assets","id":"…","op":"create","version":1}
```

### 与操作日志的关系

Two different "logs", intentionally:
- **`@zichan/logger`** = ephemeral diagnostics (dev console, crash reports).
- **`operation_log` table** (see [db.md](../db.md)) = durable, queryable **audit trail** of data
  changes, and the basis for multi-device sync. Business history lives in `operation_log`;
  the logger is for observing the running app.

## 测试

`npm test -w @zichan/logger` covers level filtering, scope/field composition, shared
level updates, error serialization, JSON output, sink failure isolation and bounded retention.
