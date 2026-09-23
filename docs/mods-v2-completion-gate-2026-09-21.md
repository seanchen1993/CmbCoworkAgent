# 完成前门禁：生产接入与边界

> 2026-09-24：最新已实现能力、验证结果和未完成项见[当前实施状态](mods-v2-status-2026-09-24.md)。下方旧批次数字和缺口保留为历史记录，不代表最新代码。

> 本页记录第 2 批桥接的历史实现。2026-09-23 当前版本已接入证据账本、项目 DIY 配置、
> 固定版本 Autobiz compiler/validator、修复后重新捕获与重复事件去重；因此下方
> “单文件模型检查/尚未记录证据”只描述早期批次。2026-09-24 已接入 Windows 两状态文件 CAS/journal，并完成一次真实模型修复及业务断言演示；
> 这不构成整个工作区原子事务或全面业务验收，未知提交仍需人工核对。最新状态见
> [续做快照](mods-v2-next-iteration-handoff-2026-09-22.md)。

本批沿用 `mods-v2-iteration-plan-2026-09-21.md`，所有代码在 ModsV2 工作树。

## 接入路径

桌面 agent IPC 的三条已有完成路径 → 原 `runCompletionHooksWithRevision` →
ModsManager 绑定当前主线程 runtime → FunctionModsManager 捕获已加载 session/generation/grant →
FunctionSession 执行 `completion.check` → 原 Agent 修复流 → 再次检查。

工作流通知专用轮次不运行门禁，避免吞掉已执行工作流的结果通知。没有 Mods 或没有注册门禁时不调用模型、不扫描文件。
此批不承诺远程、所有后台执行器、子 Agent 和全部任务完成状态都已接入。

## 这是 CMB 扩展，不是 Claude 同名兼容声明

`completion.check` 只接受精确事件注册；通配观察者不会意外成为强制门禁。
输入有 `turnId`、最新 `answer`、`revisionAttempts` 和 `maxRevisionAttempts`。
返回 `{decision:"pass"}`、`{decision:"revise",reason}` 或 `{decision:"block",reason}`。
原因不能为空且不超过 8000 字符。所有门禁独立执行，后一个 PASS 不能抹除前一个失败。
`next(e)` 仅表示该处理器不提出异议，不会跳过其他插件；`.catch` 不用于强制门禁异常放行。
后续 Claude Stop 适配必须另做契约对照，不把该接口写成 upstream parity。

## 失效和预算

- session、grant、runtime binding 绑定到检查创建时的实例，撤权、重载或主实例替换拒绝旧检查。
- 整组检查使用 120 秒 AbortSignal；guest、SDK 和模型受原有取消/权限/用量边界约束。
- 无效输出、模型调用异常和检查超时不算通过；修复次数与传统 Hook 共享上限。
- `turn.complete` 仍为结束后观察事件，不能用于完成前门禁。
- `FUNCTION_HOST_REVISION` 已更新，因此旧授权摘要不会自动获得新增宿主行为，需要重新授权。
- 当前只对本轮已加载的插件建立门禁；不等同于企业“插件加载失败也必须禁止启动”的受管 admission 策略。

## Autobiz 的实际变化

`/kanban` 面板可选择关闭、仅报告、阻止完成、自动修复并复检，并保存一个相对文件路径。
也可用 `/kanban-mode off|report|check|repair`、`/kanban-target src/export-orders.ts` 设置。
保存后普通任务结束前自动运行，不需要每次再输入 `/kanban-review`。
评审结果通过 `/kanban-last` 或面板查看；成功结束时追加自动评审摘要。

当前评审仍是单文件、模型判断；通过不代表测试或 Feature 业务验收通过，不自动推进 checkpoint。
文件在评审期间变化会拒绝使用旧结果。配置和最新报告使用宿主存储，但尚未提供完整的可恢复检查证据账本。
产物扫描已改为有数量/深度上限的目录遍历，能发现 `specs/order-export/spec.md`，避免旧示例漏检。

## 后续仍需完成

真实 diff 与需求绑定、upstream validator 调用、状态转换竞争控制、恢复与去重、完整执行面覆盖、
用户配置组合、Claude 剩余兼容矩阵、失败基线归因及完整性能门禁。
