# 2026-09-23 总模型预算验证

范围：原完成修复 loop、主模型真实 transport、摘要/子 Agent、原生工具 deadline；配合同批宿主 CompletionBudget、FunctionModels 和 manager gate 绑定。未修改 UAT 或真实 Autobiz 项目状态。

## 先失败后实现

- `2026-09-23-completion-total-budget-red.log`：首次预算与 wire 上限回归失败；早期 HTTP fixture 的非流式调用已改为实际 messages 流式调用后重新验证。
- `2026-09-23-completion-native-budget-red.log`：两项原生取消 API 回归先失败。
- `2026-09-23-completion-budget-review-red.log`：独立 review 新增三项先失败，分别是多 data 行 SSE 无分隔累积、DONE 后较大 usage 被忽略、原 Stop context 未带 deadline signal；均已修复。

## 结果

- `2026-09-23-completion-total-budget-tests.log`：6 个 suite，61 / 61 通过，12.29 秒。包含新 loop 4、真实 HTTP 12、真实 native 2，以及既有主模型边界、completion gate、模型 refusal 回归。
- 实际 native 进程 PID 36196 在 1500 ms 预算触发后被 killTree 终止，Windows 清理于约 1845 ms 完成；回归验证 PID 已不存在、父 controller 未被取消、后续 runtime 保持可用。截止时间触发与系统进程回收完成不是同一时刻，不宣称实时硬截止。
- `2026-09-23-completion-total-budget-typecheck.log`：Node 22 下 `npm run typecheck:node` 通过。
- `2026-09-23-completion-total-budget-eslint.log`：6 个文件 ESLint 0 errors；5 个预算实现/测试文件无 warning，runtime 有 42 个先前主模型/compaction 区域的格式 warning。没有为消除这些 warning 整体重排共享 runtime。

真实 HTTP 对照：关闭时保留配置的 32000 输出上限；开启后真实 wire cap 按剩余总预算缩小。实际 100 输入 + 20 输出结算为 120，cache 命中字段不额外重复计数。摘要和子 Agent 所在真实工具执行链共四次模型调用累计 400 输入 + 80 输出。502 未知用量只执行一次物理请求并阻断完成；429 明确 0 / 0 用量的失败尝试可继续下一次独立预留的重试。

性能对照是结构和执行行为回归：关闭 fetch 原样 delegate，无 body 扫描/响应包装，关闭工具预算无定时器。全应用性能、Electron 和安装包结果由主代理的最终集成报告追加；本报告不把这些窄测等同最终业务验收。

生产源码在完成上述验证后锁定，供主代理 Electron 第 8 轮及联合 typecheck 使用。能力边界详见 `docs/mods-v2-completion-total-budget-2026-09-23.md`。

## 主任务集成与提交边界

独立review发现：显式选择code-review但所有注册matcher跳过本轮时，原实现可能PASS。
新增真实guest回归先3失败1通过；修复后check/repair阻断并保存unavailable证据，report只记录，
legacy可选filter保持原行为。示例session.start写入canonical默认off并迁移旧别名，关闭后不附旧报告。
联合policy20+example12共32通过。Node/Web全项目检查、修改源码ESLint quiet均exit0。
原desktop-agent-baseline和hooks两套standalone也exit0。

全量Vitest为4088通过、26失败、5跳过；26项失败在隔离提交0273980c中全部复现，名称无差异。
Electron9/10已通过原修复循环真实模型再执行及宿主证据显示；完整status-sites仍单独复验，
不将这些结果称为DIY四模式完整业务演示。预算关闭对照包含真实HTTP原样转发、无额外计时器。

为保证独立commit不依赖未提交UI/CAS代码，将暂存树94b15e8c导出到隔离目录验证：
Node typecheck exit0，6套57/57通过，包括真实HTTP、原生进程取消、原完成循环、20个policy
用例和真实QuickJS Pane配置。日志budget-index-node、budget-index-tests。此次提交包含预算/
策略/示例配置能力；宿主证据renderer与UI sites留在后续独立提交。未改UAT，未运行打包。
