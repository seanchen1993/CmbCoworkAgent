# Claude Code Mods 最新参考审查

日期：2026-09-22  
目标工作树：`C:\ai\CmbCoworkAgent-mods-v2`  
参考版本：Claude Code `v2.1.278`，提交 `bf7d404e26a5fb6167d21b46c93a2bf6c22ab274`  
声明文件：`mods/types/claude-code.d.ts`（文件头由 `2.1.277` 生成，SHA-256 `AC107A37C08AD46F8632EDC1639B13A740FAE0B8249A2245532ADFD325E57D0D`）

## 这次审查做了什么

在工作树之外检出官方仓库 `C:\ai\claude-code-v2.1.278` 的 `v2.1.278` 标签，只读检查 `mods/README.md`、`mods/types/claude-code.d.ts` 和内建 Mod 目录。该目录不是本项目工作树，也没有修改 `C:\ai\CmbCoworkAgent` UAT 工作树。

官方 README 现在明确把 Mods 定义为一个 `register(on, options)` 函数模块，并把 `engine.create` 的 noun contract、内建 `diff`/`telemetry`/`agents-md`/`sec-default` Mods、`claude plugin test` 和多 UI surface Client 测试作为主路线。因而本工程后续优先保证宿主事件、组合规则、真实 Client 生命周期和测试契约；Autobiz 保留为最后接入的业务适配器和演示。

## 与此前参考相比的变化

| 官方方向 | 本工程处理 | 当前状态 |
| --- | --- | --- |
| `agent.offer` 返回 `{ isOffered }`，并与 `agent.spawn` 分开 | 事件名已进入事件目录；生产 Agent offer 入口仍待宿主接线 | partial |
| `classic.*` 作为一等事件命名空间，`classic.PreToolUse` 保留特殊 envelope | 事件目录已覆盖最新事件；传统 Hook runner 保留并补齐 once 并发、失败重试和 session generation 语义；避免自动双执行仍需逐个生产入口接线 | adapted/partial |
| `turn.step` 是唯一流式事件，允许 text/thinking/tool/input/stop 与 opaque chunk | 主 Agent 流已走宿主边界；插件保留的 opaque frame 有数量上限，长流不会因累计序号误拒绝 | adapted |
| `model.fork` 使用 host transcript snapshot；`model.classify` 只接收文本、标签和模型选项 | 已绑定 live snapshot、authority、generation、取消和发布前复核；模型/effort rewrite 仍按本工程边界拒绝 | adapted |
| `ui.focus`/`ui.scroll` 带 requestId、origin 和站点上下文 | Pane focus/scroll 已接入并做 generation、host dispatch 后提交；全站点参数仍标为 adapted | adapted/partial |
| Client 除 `elements/state/setState` 外还有 columns、rows、every、pointer/key、post、focus/scroll 生命周期 | 当前 Client 基础能力和 Pane 生命周期已覆盖主要路径，跨 terminal/desktop/vscode/mobile 的官方测试 surface 尚未宣称 full | partial |
| `engine.create` 提供可组合 noun contract，插件类型随安装动态生成 | 当前注册/分发链可识别 `engine.create`，但尚未提供官方同等的动态声明文件产出和第三方 noun 类型索引 | partial |
| MCP、memory、skills、agents 的 context breakdown 有专门类型 | 当前 usage breakdown 已有宿主证据，需继续逐项补齐字段并用真实 guest/session 测试锁定 | adapted/partial |
| classic 事件新增模型切换、compact、permission、elicitation、config、worktree、文件变更等 | 事件目录与兼容性矩阵已列出，生产触发器和字段映射按事件单独推进 | partial |

## 实现顺序调整

1. 先完成通用宿主能力：最新事件字段和结果验证、主 Agent 流式边界、classic Hook 触发一次且可恢复、Client 生命周期和跨 scope 失效。
2. 再完成 `engine.create`/动态 context 的可观察契约和真实 guest/session 测试；没有宿主实现的条目继续标记 `partial`，不以同名 API 计作兼容。
3. 最后把 Autobiz 固定版本 validator 接成演示适配器，验证真实需求、产物、checkpoint 和文件竞争；它不能替代通用 Mods 验收。

## 证据位置

- 最新官方声明：`C:\ai\claude-code-v2.1.278\mods\types\claude-code.d.ts`
- 最新官方 Mods 说明：`C:\ai\claude-code-v2.1.278\mods\README.md`
- 本工程映射：`docs/mods-v2-compatibility-matrix.json`
- 本次实现报告：`output/mods-v2-validation/2026-09-22-model-hooks-latest-audit.md`

官方资料：

- https://github.com/anthropics/claude-code/releases/tag/v2.1.278
- https://github.com/anthropics/claude-code/blob/v2.1.278/mods/README.md
- https://github.com/anthropics/claude-code/blob/v2.1.278/mods/types/claude-code.d.ts
