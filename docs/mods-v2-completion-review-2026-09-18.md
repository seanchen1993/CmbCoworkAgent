# Mods v2 完成度复核

**复核提交：** `b3800a49 feat(mods): align session compaction and context breakdown`

**复核日期：** 2026-09-18

## 结论

本轮已完成此前指出的 summary/full 计数、compact 外部契约和 archive retry 修正；聚焦套件、进程回归、类型检查、构建和桌面 E2E 均通过。仍不能标记为完整 upstream parity，因为动态分类、部分 B3–B8 能力和完整性能门禁尚未完成。

## 已确认通过

- 工作区为 `C:\ai\CmbCoworkAgent-mods-v2`，分支为 `codex/mods-v2`，工作树清洁。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` 通过。
- 修改 TypeScript 文件的 `eslint --no-cache --quiet` 通过。
- 复核时的历史记录为 Mods v2 69 个文件、536/536；本轮修正后 Mods v2 与 shared Mods v2 目录为 50 个文件、364/364。
- manager 专项：18/18 通过。
- 本次复跑的 manager、session-read-host、context-usage、summarization 四个文件：115/115 通过。
- 生产构建记录通过。
- breakdown 1000 次本地性能记录：P95 0.0309ms；live read P95 0.0022ms。
- 桌面 E2E：64/64 个真实场景通过，包含 summary/full usage breakdown。

## 未通过的验收门槛

### 全量 Vitest

`output/mods-v2-validation/v27-vitest-full.txt` 记录：

```text
3610 passed, 26 failed, 5 skipped, no unhandled error
```

失败数与已知 v25 基线的 26 个失败相同，失败集中在 browser/git/renderer source snapshot 等既有环境或历史断言。
Mods v2 与 shared Mods v2 聚焦套件为 364/364，通过结果未出现新增 Mods 回归；因此全量结果已完成基线对照，但仍不是全仓库绿灯。

### 桌面 E2E

最终桌面 E2E 运行通过 64 个真实场景，结果记录在 `output/mods-validation/e2e/result.json`；新增
`session.usage({ breakdown: "summary" })` 与 `session.usage({ breakdown: "full" })` 场景验证两种计数路径返回不同
breakdown。`session.compact` 的 host/runtime、skip、lease、重启和 archive retry 仍由聚焦回归覆盖，本批未把挂起的
长耗时 compact 操作伪装成桌面绿灯。

## 已修复的对齐问题

### 1. `summary` 和 `full` 已使用不同计算路径

`summary` 使用有界本地序列化估算，`full` 使用 system prompt、system tools 和 LangChain messages 的详细 estimator；
两种模式均保留 `estimated: true`，provider `apiUsage` 单独返回。回归测试和桌面 E2E 已验证两种 breakdown 数值不同。

参考：

```text
output/claude-code-2.1.273-analysis/formatted/chunk-hr43png0.js
```

`uhs`/`dhs` 对 `summary` 与 `full` 的分支就是该差异的证据。

### 2. `session.compact` 已移除外部 `filePath`

runtime 现在只向 SDK 返回 `{ messages, tokensBefore?, tokensAfter? }` 或 `{ skip }`；内部归档路径仍保存在
checkpoint 的 `SummarizationEvent.filePath`，并由恢复逻辑使用。basic SDK 会拒绝任何外部 `filePath` 字段。

## 仍需关注的状态与能力边界

- archive rollback 后清理 `commitPromise` 并重试的回归已通过；flush 失败的保守指针策略仍需在更长时间和更多重启组合下继续观察。
- `projectContextBreakdown` 仍省略动态 MCP、memory、skills、agents；这是明确的能力差异，兼容矩阵保持 `fullParity: false`。
- 完整 5×1000、长时间空闲和两小时稳定性性能门禁尚未完成。

## 后续工作

1. 继续补齐动态 MCP、memory、skills、agents breakdown 及 B3–B8 的 planned-adapter 能力。
2. 完成 standalone UAT、全量性能矩阵、长时间稳定性和更完整的 compact 重启组合。
3. 保持全量 Vitest 的 26 个已知失败基线，不把环境/历史断言误报为 Mods 回归；新增 Mods 变更仍以 364/364、37/37 和 64/64 为发布前回归门槛。
4. 所有剩余能力和性能门禁完成后，再把兼容矩阵状态改为完整 parity。

## 修复进度（本轮）

已完成此前指出的三项代码修正：`summary` 走本地序列化估算、`full` 走详细 estimator；`session.compact` 不再把
内部 `filePath` 放入插件结果；archive rollback 会清空已完成 promise，下一次提交会重新生成归档。新增回归覆盖
summary/full 数值差异、rollback 后 retry 和 guest Promise 外部 resolve 的异步 scope 归属。当前 Mods v2 与 shared
Mods v2 为 364/364、跨进程函数回归 37/37、桌面 E2E 64/64，类型检查和构建均通过；全量 Vitest 为 3610/26/5，
无 unhandled error。
