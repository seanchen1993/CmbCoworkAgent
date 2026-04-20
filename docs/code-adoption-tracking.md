# 代码生成采纳率统计 —— 技术方案

> 分支：`feature/code-adoption-tracking`
> 范围：Electron 主进程侧的埋点管道，全部为副作用流程，不影响用户主流程
> 最近更新：2026-04-20

## 1. 目标

度量 Agent（及各 Skill）生成的代码真正被开发者采纳的比例。具体包括三层埋点：

| 层级 | 含义 | 触发时机 |
| --- | --- | --- |
| **L1 `code_gen`** | 生成事件 | Agent 调用 `write_file` / `edit_file` 成功后 |
| **L2 `code_adopt` (measured)** | 10 分钟留存度量 | 代码落盘 10 分钟后，对比当前内容与生成快照的 diffRatio |
| **L3 `code_adopt` (committed)** | 提交前度量 | 用户在 Git 面板点击 commit 的瞬间，对 staged 文件再算一次 diffRatio |

并支持以下附属 `verdict`：
- **deleted**：L2 timer 到点 / commit 时尝试 `readFile` 抛 ENOENT 即判定为删除（无需单独的 watcher 通道）
- **skipped_large**：非空行数超过阈值（**3000 行**）跳过度量；**生成侧与度量侧对称生效**
  - 生成侧（`recordGen`）：先用行数上界快速判定，超过则直接发 `code_gen` + `code_adopt(skipped_large, measureSource="gen_oversize")`，**跳过哈希 / JSONL / sqlite 入库**，避免 BLOB 膨胀
  - 度量侧（`measureFile`）：读到文件当时再按非空行数二次校验

> **设计注记**：我们曾短暂接入 `workspace-watcher`，但每次 `fs.watch` 事件都会打 sqlite 查询（热路径放大），且在 10 分钟窗口内提前度量会污染 L2 语义（锁定一个用户还没改完的中间状态）。因此 **adoption-tracker 不再监听 watcher**，只依赖 `timer_10m` + `git_commit` + `gen_oversize` 三条触发源。

> 判定阈值（"算不算采纳"）**放在云端**决定，客户端只上报原始 `diffRatio`（0–100 的浮点数，保留两位小数）。

## 2. 设计原则

1. **副作用隔离**：所有埋点逻辑 `queueMicrotask` + `try/catch`，出错不外溢。
2. **客户端处理、云端聚合**：本地做滚动 JSONL + SQLite 索引，按事件粒度通过 `trackEvent()` 单条上报，不批量。
3. **隐私保护**：L1 上报**不包含** `filePath`、文件内容、指纹；L2/L3 也只上报 `verdict + diffRatio + 元数据`。
4. **主流程零感知**：内部心跳用 `setInterval().unref()`，不复用用户可见的 `services/scheduler.ts` / `services/heartbeat.ts`。
5. **有界资源**：磁盘硬顶 100MB、保留 7 天、单 shard 10MB，超额/过期丢弃，不阻塞任何调用路径。

## 3. 总体数据流

```
┌───────────────────────────┐
│ Agent Tool Call           │
│  write_file / edit_file   │
└────────────┬──────────────┘
             │ (副作用)
             ▼
┌───────────────────────────┐      ┌─────────────────────────────┐
│ adoption-tracker.recordGen│────▶ │ JSONL rolling shards        │
│  - 行数 > 3000 → 直接终结  │      │ ~/.cmbcoworkagent/          │
│    (skipped_large, 不哈希) │      │   adoption/current.jsonl    │
│  - 否则 fnv1a 行哈希快照   │      │   adoption/YYYYMMDD-xx.jsonl│
│  - 写索引 + 发 L1 事件     │      │ (记录精简：不含 lineHashes) │
│  - 所有 append 经 writeChain │      │                             │
│    串行化                  │      │                             │
└────────────┬──────────────┘      └─────────────────────────────┘
             │
             ▼
┌───────────────────────────┐      ┌─────────────────────────────┐
│ adoption-index.sqlite     │◀────▶│ 后台 sweep (5min, .unref()) │
│  gen_events (pending)     │      │  - 过期/超量清理             │
│  (BLOB 存 lineHashes)     │      │  - L2 到点触发 measureFile   │
└────────────┬──────────────┘      │  - inFlight Set 去重并发     │
             │                     └─────────────────────────────┘
             ▼
    ┌────────┴─────────┐
    │                  │
    ▼                  ▼
 L2 measured       L3 committed
 (10 min 到点)     (git commit 前夕)
    │                  │
    └────────┬─────────┘
             ▼
      trackEvent("code_adopt", "code_adoption", {...})
```

## 4. 模块组成

### 4.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `src/main/services/adoption-index.ts` | sql.js 索引：`gen_events` 表，字段含 `event_id / file_path / content_fingerprint / shard_file / shard_offset / line_hashes(BLOB) / created_at / measured`。索引在 `(file_path, measured, created_at DESC)` 与 `(created_at)`。500ms debounced 落盘。提供 `deleteOlderThan` / `deleteMeasuredOlderThan` / `trimToRowCap` / `vacuumAdoptionIndex` 维护 API。 |
| `src/main/services/adoption-tracker.ts` | 核心管道：语言识别、行哈希、diffRatio、JSONL 滚动、保留策略、L1/L2/L3 事件投递、后台 sweeper 生命周期。 |

### 4.2 修改文件

| 文件 | 变更 |
| --- | --- |
| `src/main/services/event-reporter.ts` | `EventCategory` 增加 `"code_adoption"` |
| `src/main/agent/local-sandbox.ts` | `write()` / `edit()` 成功后调用 `recordAdoptionGen(...)`，只在无 `result.error` 的成功分支 |
| `src/main/services/workspace-watcher.ts` | **不** 参与采纳率管道（前一次接入后被回退 —— 参见设计注记）。仅继续承担向 renderer 发 workspace:files-changed 的职责 |
| `src/main/ipc/git.ts` | `execute-git-command` handler 中检测 `git commit` 命令，在执行前调用 `measureForCommit(absFiles)` 对 staged 文件再算一次 diffRatio |
| `src/main/agent/trace/collector.ts` | 构造函数 / `setModelId` / `setModelName` / `setUsedSkills` / `finish` 均透传 tracker 上下文（traceId、modelId、modelName、usedSkills、primarySkill），`finish` 里 `clearAdoptionContext(threadId)` |
| `src/main/index.ts` | 启动 `initializeAdoptionTracker()`，`will-quit` 调 `shutdownAdoptionTracker()` |

## 5. 关键算法与参数

### 5.1 diffRatio（多重集合交集）

```ts
// 非空行经 trim + 折叠空白 后做 FNV-1a 32-bit 哈希
baselineLines = computeLineHashes(生成时内容)
currentLines  = computeLineHashes(当前内容)

intersection  = multiset_intersection(baselineLines, currentLines)
diffRatio     = intersection.length / baselineLines.length * 100  // 保留 2 位小数
```

- 允许行顺序变化、无视空白；不会将格式化误判为大改。
- 对 `deleted` 直接记 `diffRatio = 0`。
- 文件行数 > `MAX_LINES_FOR_MEASURE = 3000` 跳过度量，记 `skipped_large`。生成侧使用 `split("\n").length` 做廉价上界校验、度量侧使用非空行数。

### 5.2 支持的文件类型

白名单（含常见源码 + `xml` / `yaml` / `yml` 配置代码）：

```
ts, tsx, js, jsx, mjs, cjs, vue, html, css, scss, sass, less,
py, go, rs, java, kt, scala, rb, php, cc, cpp, h, hpp, cs,
swift, m, sh, bash, zsh, sql, lua, r, json, graphql, toml,
xml, yaml, yml
```

排除：
- 路径段：`node_modules / dist / build / out / .next / __pycache__ / target / .venv / venv / .git / coverage`
- 文件名模式：`package-lock.json / pnpm-lock.yaml / yarn.lock / *.min.js / *.min.css / *.map`

### 5.3 常量

| 名称 | 值 | 用途 |
| --- | --- | --- |
| `L2_MEASURE_DELAY_MS` | 10 min | L2 延时 |
| `L2_RETENTION_MS` | 7 day | 索引/shard 保留上限 |
| `SWEEP_INTERVAL_MS` | 5 min | 后台扫描间隔（L2 端到端延迟最多 10 + 5 = 15 min，可接受） |
| `SHARD_SIZE_LIMIT_BYTES` | 10 MB | 单 shard 封口阈值 |
| `DISK_HARD_CAP_BYTES` | 100 MB | JSONL 磁盘总硬顶（超过则按 sealed shard 从最旧开始丢） |
| `MAX_LINES_FOR_MEASURE` | 3000 | 超过跳过度量（生成侧 + 度量侧对称应用） |
| 线程上下文 LRU | 32 | 每个进程同时追踪的 thread 上限 |
| `INDEX_MEASURED_RETENTION_MS` | 3 day | 已度量行的保留窗口（比 7 天全量保留更激进，但留足时间供回溯排查） |
| `INDEX_MAX_ROWS` | 5000 | sqlite 硬行数上限；超出时优先删最旧的已度量行 |
| `INDEX_VACUUM_EVERY_N_SWEEPS` | 12 | 约 1 小时一次 VACUUM，回收 DELETE 后的空闲页 |

## 6. 上报事件契约

所有事件走统一的 `trackEvent(name, category, properties)`：

### 6.1 `code_gen`（L1）

```jsonc
{
  "name": "code_gen",
  "category": "code_adoption",
  "properties": {
    "eventId": "uuid",
    "threadId": "...",
    "traceId": "...",
    "tool": "write_file | edit_file",
    "language": "ts",
    "lineCount": 87,
    "usedSkills": ["skill-a", "skill-b"],
    "primarySkill": "skill-a",
    "modelId": "claude-sonnet-4-6",
    "modelName": "Claude Sonnet 4.6",
    "createdAt": 1731212345000
  }
}
```

> **隐私**：不含 `filePath`、`contentFingerprint`、文件内容、行哈希。

### 6.2 `code_adopt`（L2 / L3）

```jsonc
{
  "name": "code_adopt",
  "category": "code_adoption",
  "properties": {
    "eventId": "a_<uuid>",
    "genEventId": "g_<uuid>",     // 关联 L1
    "threadId": "...",            // 仅 gen_oversize 场景携带，其余为 null
    "traceId": "...",
    "verdict": "measured | committed | deleted | skipped_large",
    "diffRatio": 87.35,            // 0..100 浮点，2 位小数；skipped_large/unmeasurable 时为 null
    "measureSource": "timer_10m | git_commit | gen_oversize",
    "measureLatencyMs": 600123,
    "measuredAt": "2026-04-20T10:30:00.000Z",
    "commitSha": null              // L3 场景可携带
  }
}
```

- `measureSource = "gen_oversize"`：生成时已判定 baseline 过大，立即产出的终态事件（与 L1 在同一微任务内发出，`measureLatencyMs = 0`）。
- 阈值 → 采纳与否由**云端**处理，客户端不做分桶。

## 7. 生命周期 & 可靠性

- **启动**：`initializeAdoptionTracker()` 在 `initializeDatabase()` 之后调用；失败则打印警告，不抛。
- **关闭**：`shutdownAdoptionTracker()` 在 `will-quit` 阶段 flush 索引、停 sweeper；`setInterval().unref()` 保证不阻塞进程退出。
- **异常**：tracker 内部每个入口都用 `try/catch`；任何异常只输出 `console.warn`，绝不向 Agent / UI 冒泡。
- **幂等性**：L2 到点若该文件已有更新的生成事件，只度量"最近一次"的生成；已度量的记录会被标记 `measured=1` 并在保留期后清理。
- **并发安全**：
  - `appendChain`：所有 JSONL append 经 Promise chain 串行化，避免两个并发 `recordGen` 读取到相同的 `currentShardSize` 导致 sqlite 索引里的 `shard_offset` 别名重叠。
  - `inFlightMeasurements`：以 `gen_events.event_id` 为 key 的去重集合。`timer_10m` sweep 与 `git_commit` 可能在同一毫秒对同一 pending 行触发度量，若不去重，两个 microtask 都会通过 `measured=0` 判定并各自发出一条 `code_adopt`。
- **sqlite 文件大小控制**（三层护栏）：
  1. **已度量行激进清理**（`deleteMeasuredOlderThan`）：`measured=1` 的行对后续 pending 查询已无价值，保留期降至 3 天（远短于 JSONL 的 7 天）。
  2. **硬行数上限**（`trimToRowCap`）：超过 `INDEX_MAX_ROWS = 5000` 时，优先删最旧的已度量行；仍不够才触碰未度量行（会丢一点 L2 数据，作为最后兜底）。
  3. **周期 VACUUM**（`vacuumAdoptionIndex`）：sqlite DELETE 只释放页到 free list，不缩文件。每约 1 小时（12 次 sweep）做一次 VACUUM，物理回收空间。
  - 稳态实测：重度使用场景下 sqlite 文件应稳定在 5 MB 以内；极端生成高峰由行数上限兜底到数十 MB 量级。

## 8. 验证

- `npm run typecheck:node`：本分支新增两个文件零 TS 错误；其它三处 TS 报错均为 main 分支既有问题，未被本次改动引入。
- `npx eslint src/main/services/adoption-*.ts`：两个新文件 0 warning / 0 error。

## 9. 后续可选工作（非本期）

- 运营面板增加"采纳率"视图（按 skill / model / language 聚合）
- 后端补充阈值分桶规则（例如 `committed & diffRatio ≥ 70` 视为采纳）
- 增加更多语言识别（如 Jupyter `.ipynb`，需特殊处理 cell 级别）
- 若后续需要服务端回溯，再评估是否要把 `contentFingerprint` 纳入上报（当前明确不发）

## 10. 快速定位

| 你想看什么 | 去哪里 |
| --- | --- |
| 事件结构 / 字段 | `src/main/services/adoption-tracker.ts` → `emitGenEvent` / `emitAdoptEvent` |
| diffRatio 计算 | `src/main/services/adoption-tracker.ts` → `computeDiffRatio` |
| 索引表结构 | `src/main/services/adoption-index.ts` → `CREATE TABLE gen_events` |
| 生成埋点 | `src/main/agent/local-sandbox.ts` → `write()` / `edit()` |
| 提交埋点 | `src/main/ipc/git.ts` → `triggerAdoptionMeasurementForCommit` |
| 上下文注入 | `src/main/agent/trace/collector.ts` |
| 启停 | `src/main/index.ts` |
