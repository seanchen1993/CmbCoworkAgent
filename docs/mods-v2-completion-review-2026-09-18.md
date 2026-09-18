# Mods v2 完成度复核

**复核提交：** `b3800a49 feat(mods): align session compaction and context breakdown`

**复核日期：** 2026-09-18

## 结论

本提交已经完成了主要实现骨架，不能标记为最终完成。聚焦功能通过，但全量测试和桌面 E2E 没有通过，且仍有两个直接影响 Claude Code 对齐度的实现问题需要修复。

## 已确认通过

- 工作区为 `C:\ai\CmbCoworkAgent-mods-v2`，分支为 `codex/mods-v2`，工作树清洁。
- `npx tsc --noEmit -p tsconfig.node.json --composite false` 通过。
- 修改 TypeScript 文件的 `eslint --no-cache --quiet` 通过。
- Mods v2 聚焦记录：69 个文件、536/536 通过。
- manager 专项：18/18 通过。
- 本次复跑的 manager、session-read-host、context-usage、summarization 四个文件：115/115 通过。
- 生产构建记录通过。
- breakdown 1000 次本地性能记录：P95 0.0309ms；live read P95 0.0022ms。

## 未通过的验收门槛

### 全量 Vitest

`output/mods-v2-validation/v26-vitest-full-final.txt` 记录：

```text
3595 passed, 40 failed, 5 skipped, 1 unhandled error
```

仓库此前的 v25 说明基线为 26 个失败；归档 JSON `output/mods-v2-validation/vitest-full.json` 实际记录 27 个失败。因此本次全量运行不能作为绿灯，至少需要重新区分：

- 历史环境/时序失败；
- 本次新增的 13～14 个失败；
- Mods 变更是否造成任何真实回归。

当前新增失败主要包含全量并发下的 manager、git、workflow、parser、trace 超时，不能仅凭“聚焦测试通过”就宣布全量回归无问题。

### 桌面 E2E

`output/mods-v2-validation/v26-e2e.txt` 记录 57 个场景通过，随后在
`tests/mods-e2e.spec.ts:2562` 等待“插件”按钮时触发 deadline。更重要的是，当前 E2E 文件中没有检索到 `session.compact` 或 `breakdown` 的真实桌面场景，因此新增能力尚未获得端到端证明。

## 必须修复的对齐问题

### 1. `summary` 和 `full` 当前实际返回同一套计算

`src/main/agent/context-usage.ts:113-130` 接收了 `detail`，但后续没有使用它；
`src/main/mods/v2/session-read-host.ts:86-95` 只是转发参数。因此：

- `session.usage({ breakdown: "summary" })` 和 `session.usage({ breakdown: "full" })` 的分类和估算逻辑相同。
- Claude Code 反编译产物中，summary 使用本地摘要计数，full 可以使用更完整的上下文计数路径。
- 后续实现至少要明确两种模式的字段和计数差异，并为两种模式分别增加回归测试。

参考：

```text
output/claude-code-2.1.273-analysis/formatted/chunk-hr43png0.js
```

`uhs`/`dhs` 对 `summary` 与 `full` 的分支就是该差异的证据。

### 2. `session.compact` 对插件暴露了 Claude Code 没有的 `filePath`

`src/main/agent/runtime.ts:7218-7223` 将内部归档路径放入外部结果；
`src/main/mods/v2/basic-sdk.ts:145-153` 也为其增加了公开校验。

冻结的 Claude Code 2.1.273 行为是：

```text
{ messages, tokensBefore?, tokensAfter? }
```

或：

```text
{ skip }
```

归档路径可以继续保存在 checkpoint 的内部 `SummarizationEvent.filePath`，但不应作为 SDK 结果字段返回，否则使用方式和结果契约不一致。需要删除外部 `filePath`，保留内部恢复信息，并同步测试和文档。

## 需要继续验证的状态一致性问题

- `CmbCompactionPlan.commitArchive()` 在归档已提交后，如果 checkpoint 更新失败并执行 `rollbackArchive()`，内部已解析的 `commitPromise` 仍可能保留旧 Promise；同一个 plan 被重试时可能得到已删除的旧路径，而不是重新 staging。应增加“失败后同一 plan 重试”的测试并清理该状态。
- flush 失败时保留归档指针是合理的保守策略，但必须增加重启恢复测试，证明 checkpoint 和归档指针不会形成悬空或旧摘要复活。
- `projectContextBreakdown` 将动态 MCP、memory、skills、agents 省略，这属于当前明确的能力差异；不能在兼容矩阵中把它描述成完整 upstream parity。

## 下一步顺序

1. 先修复 `summary/full` 分支和 compact 外部结果契约。
2. 增加 breakdown summary/full、compact 外部结果、archive retry、flush failure、restart recovery 测试。
3. 增加真实桌面 E2E：usage summary、usage full、compact success、compact skip、active lease rejection、restart recovery。
4. 在单 worker 和受控并发两种方式重新跑全量 Vitest，生成新的差异清单。
5. 修复或隔离新增的 manager/全量时序失败后，再重新跑 E2E 和性能门禁。
6. 最后更新兼容性矩阵和最终交付文档，只有所有门槛满足后才标记完成。

