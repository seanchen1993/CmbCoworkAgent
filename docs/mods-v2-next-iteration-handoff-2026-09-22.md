# Mods v2 继续迭代交接方案

日期：2026-09-22  
目标工作树：`C:\ai\CmbCoworkAgent-mods-v2`  
目标分支：`codex/mods-v2`  
UAT 工作树：`C:\ai\CmbCoworkAgent`

## 先说结论

本工程已经有可运行的 Function Mods 平台基础：插件快照、授权、隔离运行时、命令、文件读取、模型调用、Pane UI、会话生命周期和部分完成门禁都已经存在。

但是“安装一个团队研发模式后，任务结束自动评审，失败自动修复，修复后复检，验证通过才推进 Autobiz 阶段”还没有完成。下一阶段不是重新实现 Mods 运行时，而是把现有完成循环、Function Mods 和 Autobiz 的真实业务校验器接成一个有证据、可恢复、可审计的闭环。

## 当前基线必须这样认定

- `codex/mods-v2` 的最近已提交基线为 `423410cb feat(mods): establish bounded completion gate foundation`。
- 该提交之前的基础能力和第 1 批完成门禁属于已提交代码。
- 当前工作树还有第 2 批生产桥接和 Autobiz 示例的未提交修改。开始新批次前，必须先审查 `git diff`，补测试并单独提交；不能把文档中“已完成”直接当成已发布事实。
- 任何开发都在 `C:\ai\CmbCoworkAgent-mods-v2` 进行，禁止在 `C:\ai\CmbCoworkAgent` 的 UAT 工作树直接修改或合并。

## 用户最终应该看到的效果

安装并启用“Autobiz 研发模式”后，用户只需说“实现订单导出”。模式按照配置执行：

1. 主 Agent 正常实现代码。
2. 任务准备结束时，Mods 读取本轮变更、绑定的需求和当前工作树版本。
3. 运行代码评审和真实项目 validator。
4. 仅报告模式只展示结果；强制检查模式在失败时阻止结束；自动修复模式把明确的问题交回主 Agent。
5. 修复后旧的 PASS 立即失效，重新收集 diff、重新检查，直到通过、预算耗尽、用户取消或明确阻止。
6. 只有有效检查证据、当前 checkpoint 和文件指纹都没有变化时，才允许推进 Autobiz 状态。
7. 重启、撤权、切换工作区、配置变化和并发修改都不能复用旧的通过结果。

这是“DIY Claw”的验收目标。单独增加 `/kanban-review` 或显示一个状态面板，不足以通过验收。

## 已有能力与缺口

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Mods 安装、快照、授权、撤权、隔离运行 | 已有 | 不应重复建设 |
| 命令、文件读取、模型调用、Pane UI | 已有 | 可作为 Autobiz 模式的 SDK 基础 |
| session、turn、authority、generation、取消 | 已有基础 | 新代码必须复用，不得绕过 manager/host |
| 完成门禁 `completion.check` 基础 | 第 1 批已提交 | 严格区分 pass/revise/block，共享修复预算 |
| Function Mods 接入主 Agent 完成循环 | 第 2 批工作树中 | 需先检视未提交 diff、测试并提交 |
| Autobiz `off/report/check/repair` | 第 2 批工作树中 | 当前仍主要是单文件模型评审 |
| 本轮 diff 与需求绑定 | 未完成 | 当前评审可能只绑定一个路径 |
| 真实 Autobiz validator | 未完成 | 不能把非空文件或模型自报 PASS 当作验收 |
| 修复后重新收集证据和去重恢复 | 未完成 | 旧 PASS 必须失效 |
| checkpoint 竞争控制和状态推进 | 未完成 | 校验与提交之间必须再次确认版本 |
| 可配置 DIY 界面和项目作用域 | 部分 | 命令可用，完整配置体验未完成 |
| Claude 全部事件、主 Agent 模型控制、动态 breakdown、完整 UI | 未完成 | 属于原对齐计划的后续项 |

## 分批实施方案

### 批次 0：冻结基线并审查第 2 批

先执行：

```powershell
cd C:\ai\CmbCoworkAgent-mods-v2
git checkout codex/mods-v2
git status --short
git diff --stat
git diff -- src/main/agent/skill-lifecycle/completion-hooks.ts src/main/ipc/agent.ts src/main/ipc/mods.ts src/main/mods/v2/manager.ts examples/autobiz-kanban-mods
```

重点确认：三条桌面 agent 完成路径是否都进入门禁；工作流通知是否跳过；没有插件或没有门禁时是否零模型、零扫描；取消、撤权、runtime 替换后是否拒绝迟到结果；传统 Hook 行为是否没有回归。

门禁：完成门禁、Autobiz gate、Mods 生命周期、桌面 E2E 和类型检查全部有当前批次结果，之后将第 2 批单独提交。

### 批次 1：完成门禁基础（已提交，但继续作为回归基线）

保留 `pass/revise/block` 严格结果、共享修复次数和 AbortSignal。无效输出、异常、超时、撤权和取消不能转成 PASS。补充基线对照，避免把全仓库既有失败误判成新回归。

### 批次 2：Function Mods 生产桥接（工作树中，需先收口）

复用原有 `runCompletionHooksWithRevision`，不要另写主 Agent 循环。Function Mod 通过精确的 `completion.check` 注册进入完成前阶段，绑定 workspace、thread、turn、runtime generation 和授权 digest。

Autobiz 的四种模式必须明确：

- `off`：不检查；
- `report`：检查并展示，不阻止完成；
- `check`：失败则阻止完成；
- `repair`：失败则请求原 Agent 修复，再重新检查。

当前实现仍需确认“repair”确实回到原 Agent 完成循环，而不是只返回一段文字；必须有真实 E2E 断言。

### 批次 3：证据绑定与可恢复执行

实现一个不可伪造的检查证据对象，至少包含：workspace、thread、turn、run、plugin digest、runtime generation、目标文件/变更指纹、需求版本、检查输入摘要、模型响应、validator 结果、时间和尝试次数。

规则：

- 评审期间文件、需求或配置变化，检查结果作废；
- 修复后旧 PASS 作废；
- 重启后重新确认授权和工作树版本；
- 用户取消、拒绝或撤权不自动重启；
- 有副作用的状态推进必须有幂等键和重复提交保护；
- 记录只能由宿主提交，插件不能伪造“已测试”或“已验收”。

验收：中断、重启、重复完成事件、撤权、文件竞争修改各有测试。

### 批次 4：Autobiz 真实业务闭环

不要继续使用单文件模型评审作为最终验收。通过受控 host 调用上游真实 validator，读取真实 `.autobizdevops/state.json` 和 Feature 目录，得到结构化结果：

```ts
{
  passed: boolean
  checkpoint: string
  feature: string
  findings: Array<{ code: string; path?: string; message: string }>
  evidence: Array<{ path: string; sha256: string; size: number }>
}
```

只有 validator 通过、需求和代码证据仍匹配、checkpoint 未变化时，才允许状态转换。转换前后重新读状态并检查指纹。保留 classic hooks，明确哪些由 Mods 启用，避免同一检查执行两次。

验收场景：缺需求、缺产物、代码缺陷、测试失败、validator 超时、状态被外部修改、重复推进、动态 `workflow.d`、blocked checkpoint。

### 批次 5：DIY 用户体验

提供可理解的配置面板，而不是让用户只记命令：

- 模式：关闭 / 仅报告 / 阻止完成 / 自动修复；
- 范围：当前文件、当前 diff、指定 Feature、整个项目；
- 检查项：代码评审、单测、E2E、Autobiz validator；
- 预算：最大修复次数、最长时间、模型用量；
- 结果：当前规则、实际执行步骤、证据、失败原因、下一步动作。

配置按项目保存，重启后恢复；关闭后不得残留门禁；同一任务必须录制关闭/开启两组对照，证明开启后确实减少人工步骤或阻止错误完成。

### 批次 6：Claude 对齐计划剩余项

继续按 `docs/mods-v2-compatibility-matrix.json` 逐项处理，不以同名 API 代表兼容：

1. Claude 经典事件字段、时序、错误和取消语义；
2. 主 Agent 模型控制、turn step/fork/classify、流式边界；
3. MCP、memory、skills、agents 的动态上下文 breakdown；
4. 内建工具参数和 JSON Schema；
5. 完整 UI site、组件、焦点、滚动和 Client 生命周期；
6. standalone UAT、5×1000 性能矩阵、长时间稳定性、重启和 compact 组合。

## 每批必须执行的验证

顺序固定：窄测 → 类型检查 → 修改文件 ESLint → 真实 guest/session 集成测试 → Electron E2E → 全量基线对照 → 性能。

最低验收集合：

- gate pass/revise/block；
- 无插件、report、check、repair 四种模式；
- 修复后复检和旧 PASS 失效；
- 取消、撤权、runtime 替换、文件竞争修改；
- 预算耗尽和模型错误；
- 重启恢复、重复完成事件和重复状态提交；
- Autobiz validator 真实结果；
- 关闭模块无额外模型或扫描调用；
- 真实安装 ZIP 的 `plugin check` 和桌面加载。

每批在 `output/mods-v2-validation/` 使用新的日期文件名，不能覆盖历史结果。失败必须分为“本批回归、既有基线、环境问题、未覆盖”，不能笼统写成通过。

## Claude Code 参考边界

官方 Mods 说明中，Mod 是带有 `register(on, options)` 的插件 Hook 模块；官方 `diff` Mod 通过 `/diff` 打开面板，并在文件变化和命令执行后刷新；官方测试也直接使用 engine `$` 和插件 `on`。这说明目标是“可编程、可组合、由事件持续驱动的插件”，不是增加几个手动命令。

参考：

- https://github.com/anthropics/claude-code/blob/b782847db9a18667f00918ea341197f201b22bb4/mods/README.md
- https://code.claude.com/docs/en/hooks

## 参考资料索引

### 原始架构与调研

```text
C:\Users\87624\xwechat\_files\wxid_amfml3ktb7tu21\_a7a4\msg\file\2026-09\EXTERNAL.Function.Hooks.Core.Architecture.pdf
C:\ai\CmbCoworkAgent-mods-v2\docs\mods-project-value-and-claude-code-recovery-2026-09-15.md
C:\ai\CmbCoworkAgent-mods-v2\docs\claude-code-mods-local-verification-2026-09-15.md
```

### 总体设计和完成度

```text
docs/mods-v2-parity-design-2026-09-16.md
docs/mods-v2-final-implementation-plan.md
docs/mods-v2-iteration-plan-2026-09-21.md
docs/mods-v2-status-and-gap-2026-09-18.md
docs/mods-v2-completion-review-2026-09-18.md
docs/mods-v2-completion-gate-2026-09-21.md
docs/mods-v2-compatibility-matrix.json
```

### 宿主和运行时边界

```text
docs/mods-v2-host-foundation-2026-09-17.md
docs/mods-v2-agent-authority-design-2026-09-17.md
docs/mods-v2-runtime-authority-2026-09-17.md
docs/mods-v2-agent-instances-2026-09-17.md
docs/mods-v2-turn-lifecycle-2026-09-18.md
docs/mods-v2-background-turns-2026-09-18.md
docs/mods-v2-child-turns-2026-09-18.md
docs/mods-v2-turn-presentation-2026-09-18.md
docs/mods-v2-refusal-turns-2026-09-18.md
```

### SDK、会话、工具和验证

```text
docs/mods-v2-authoring.md
docs/mods-v2-session-read-2026-09-18.md
docs/mods-v2-context-usage-2026-09-18.md
docs/mods-v2-tool-catalog-2026-09-17.md
docs/mods-v2-tool-permission-2026-09-17.md
docs/mods-v2-mcp-sdk-2026-09-17.md
docs/mods-v2-mcp-tool-routing-2026-09-17.md
docs/mods-v2-registered-mcp-2026-09-17.md
docs/autobiz-kanban-mods-demo-2026-09-21.md
```

### Claude Code 2.1.273 反编译和行为对照

```text
output/claude-code-2.1.273-analysis/manifest.json
output/claude-code-2.1.273-analysis/formatted/chunk-hr43png0.js
output/claude-code-2.1.273-analysis/extracted/chunk-c5xn880r.js
output/claude-code-2.1.273-analysis/extracted/chunk-x1btkhgs.js
output/claude-code-2.1.273-analysis/extract_bun.py
output/claude-reference/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts
output/mods-v2-validation/context-controller-research.md
output/mods-v2-validation/claude-code-2.1.273.d.ts
output/mods-v2-validation/claude-conformance.txt
output/mods-v2-validation/claude-sdk-conformance.txt
output/mods-v2-validation/usage-full-comparison.txt
```

反编译产物只作为行为证据，不能复制私有实现或用名称存在冒充行为一致。

## 新会话直接复制的提问词

```text
请在 C:\ai\CmbCoworkAgent-mods-v2 的 codex/mods-v2 分支继续实现 Mods v2，不要修改或合并 C:\ai\CmbCoworkAgent 的 UAT 工作树。

第一步先阅读并遵守：
C:\ai\CmbCoworkAgent-mods-v2\docs\mods-v2-next-iteration-handoff-2026-09-22.md
C:\ai\CmbCoworkAgent-mods-v2\docs\mods-v2-iteration-plan-2026-09-21.md
C:\ai\CmbCoworkAgent-mods-v2\docs\mods-v2-final-implementation-plan.md
C:\ai\CmbCoworkAgent-mods-v2\docs\mods-v2-status-and-gap-2026-09-18.md
C:\ai\CmbCoworkAgent-mods-v2\docs\mods-v2-completion-gate-2026-09-21.md
C:\ai\CmbCoworkAgent-mods-v2\docs\mods-v2-compatibility-matrix.json

再检查 git status、git diff 和最近提交 423410cb。当前工作树中的第 2 批修改必须先做代码检视、补测试和回归，确认没有问题后单独提交；不能直接假设文档中的“已完成”可信。

然后只实现下一批：证据绑定与可恢复执行。要求：
1. 检查输入绑定 workspace/thread/turn/run、plugin digest、runtime generation、当前 diff、需求版本和文件指纹。
2. 评审期间或修复后任何输入变化都会使旧 PASS 失效。
3. 支持取消、撤权、runtime 替换、重启、重复完成事件、并发文件修改、预算耗尽和模型错误。
4. 记录检查、修复尝试、validator 结果和状态推进证据；插件不能伪造测试或验收结论。
5. 不绕过 ModsManager、FunctionSession、authority、lease、generation、原有完成循环和 checkpoint。

先写测试和失败场景，再实现。必须运行窄测、typecheck、ESLint、真实 guest/session 集成测试和 Electron E2E。每次验证使用 output/mods-v2-validation/ 下新的日期文件。完成后说明改动、测试结果、已知基线失败、剩余差距，并停在可审查提交上。

不要把单文件模型评审、非空文件检查或 plugin check 通过描述成 Autobiz 业务验收完成。后续批次再接真实 validator、状态转换和 DIY 配置体验。
```

如果新会话已经完成第 3 批，下一次提问只需把“只实现下一批：证据绑定与可恢复执行”替换为“继续批次 4：Autobiz 真实业务闭环”，并要求先复核第 3 批提交和证据。
