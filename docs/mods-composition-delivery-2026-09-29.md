# 跨插件 Claw 组合与侧栏交付记录

后续增量已完成 Skill / MCP 来源选择与真实执行约束，最新状态、使用方式和回归结果见 [多来源组合交付](./mods-skill-mcp-delivery-2026-09-29.md)。本文件保留上一阶段记录。

开发目录：`C:\ai\CmbCoworkAgent-mods-v2`；分支：`codex/mods-v2`。未修改 UAT，主工程未提交、推送或发布安装包。
生成的合成演示目录有独立 Git 初始提交，用于隔离外层工程的成果指纹，与主工程提交无关。
本次修改基于已有大量未提交开发内容；不能把整个工作区 diff 都算成本轮新增。

## 现在能做什么

用户可以把 **A 插件导出的动作 → B 插件导出的动作 → Agent/真实检查/人工确认** 组成流程，
明确把前一步的结构化输出交给后一步。不同 Agent 节点可以选择不同模型或 Claw 模型角色。
插件动作可以通过其契约参数请求宿主模型，仍受模型范围、权限、取消与发布检查约束。

Claw 现在保存插件来源、主助手默认模型、角色模型和已保存流程副本。保存模板、应用到对话、
执行任务是三个不同动作。同一个项目里的不同普通对话可以绑定不同组合；修改模板不会更换已应用副本。
同项目的显式 Flow 仍互斥，避免两次执行同时修改同一工作目录。

对话仅保留一个输入框，明确选择“聊天 / 执行流程”。Claw 的运行、配置和插件结果移到右侧。
宽屏可以调整侧栏宽度，窄屏使用抽屉；关闭侧栏不取消任务。输入区保留待确认、失败与取消入口。
“带运行摘要追问”切回普通聊天，不会再次启动流程。

实际例子是两个独立插件：Autobiz 读取真实 Feature 状态及文件，Review 接收前步输出并等待模型检视完成。
它们不是一份插件里两个不同名称的卡片。请按 [逐步体验手册](mods-composition-hands-on-2026-09-29.md) 操作。

## 设计和检视闭环

实现前先收敛 [实现契约](mods-composition-implementation-contract-2026-09-29.md)，
由两位 agent 分别完成 [架构评审](mods-composition-architecture-review-2026-09-29.md) 和
[质量、交互评审](mods-composition-quality-review-2026-09-29.md)，通过约束后实施。
实施后由独立验证 agent 再检视关键生产链路，记录在 [验证计划与结果](mods-composition-verification-plan-2026-09-29.md)。

检视和测试实际发现并修复了这些问题：

- 调整当前对话的组合原本可能影响同项目其他对话；现在只关闭当前空闲对话的资源，绑定键包含 thread incarnation。
- 保存模板后已应用配置可能漂移；现在保存完整配置和流程副本，运行使用自己的快照。
- 动作不能只按命令名称调用；现在核对导出、源码摘要、注册 owner、授权代次和真实执行结果。
- 只含插件动作的流程也会用模型；现已固定角色模型配置指纹及有效默认模型选择，执行边界检查变化。
- 禁用 Agent 步骤后不应因其缺失模型阻止保存或聊天；只检查启用步骤的显式模型。
- 摘要追问必须恢复聊天意图；已修复并加入交互回归。
- 原对话模型不可用、Claw 默认模型可用时，前端发送校验也必须采用有效 Claw 模型。
- 最终 Electron 边界测试发现模型水合/回退双 effect 更新循环；真实组件测试复现旧版失败后，改为按元数据源身份幂等水合，未替换聊天滚动架构；最终原场景 Electron 已通过。
- 编辑新组合时需要看到当前组合以外的候选动作；目录现在发现工作区已授权来源，真正运行仍检查当前绑定。
- 目录读取复用一次插件状态结果，避免一次目录请求重复编译发现；目录读取不会执行插件动作。

## 验证结果

测试使用 Node 22。所有原始日志和截图在 `output/`，不会作为源码提交。
以下结果据实际工具退出码和产物记录；已发现的两项 P1 均经修复及最终动态回归关闭。

| 验证 | 结果和证据 |
| --- | --- |
| 类型检查 | `npm run typecheck` 通过，`output/mods-composition-typecheck.log` |
| 生产构建 | `npm run build` 通过，`output/mods-composition-build.log` |
| 浏览器交互 | 17 组通过；保存、显式意图、侧栏 20 次开关、旧审批 nonce、隐藏审批提示、组合快照和摘要追问 |
| 模型恢复交互 | 真实 React/Radix 组件的延迟持久化回归通过：失效模型回退、手动选择不回滚、元数据真正改变与切换线程 |
| 用户示例 | 实际 QuickJS 示例测试通过：真实文件 → 独立 Review → 等待模型边界，确认未改变 Feature 状态 |
| 实际生成包联调 | `output/mods-composition-delivery/package-probe.json` 通过；完整打包模块、上游生成阶段数据、合成项目 → 独立 Review；模型边界受控 |
| 两个导入包 | 用最终构建的 `plugin check` 校验均退出 0；`mods-composition-autobiz-package-check.log`、`mods-composition-review-package-check.log` |
| 全量 Vitest | 666 文件，5,257 通过、14 失败、5 跳过；见下方失败分类 |
| 冻结代码后复测 | `mods-composition-final-recheck.log`：动作契约、模型策略、NativeHost、Claw/Flow IPC及浏览器服务六文件 63 项全部通过 |
| 完整 Mods 回归 | 195 文件、1,759 项全部通过；`output/mods-composition-final-mods.log` |
| 旧业务 Flow Electron | 9 组全部通过，包括真实修复/测试/阶段提交、摘要追问、重启恢复；`output/mods-composition-flow-e2e-final.log` |
| 最终组合 Electron | 11 组全部通过、`pageErrors: []`；真实双插件/双模型、绑定隔离、取消、撤权零动作、失效旧模型与审批刷新；`output/mods-composition-e2e/report.json` |
| 定向 ESLint | 本轮后端、renderer、协议、示例和 E2E 定向检查通过；不对巨大旧文件执行整份格式化 |
| 全仓 ESLint | 未通过：101 errors / 579,926 warnings；其中本轮一个测试参数未使用已修复并定向通过，其余见 `mods-composition-lint-errors.json` |
| 传统 Plugin/Harness Electron | 已执行 7 组通过；最终功能输出变更不涉及旧模式链路 |

全量 Vitest 中 11 项为此前复现的基线问题：5 项 macOS IDE 路径夹具在 Windows 不适配，5 项缺少
Chrome 扩展源码文件，1 项主题检查路径分隔符问题。另有浏览器服务 1 项超时，以及运行期间源文件更新
导致旧模块转换缓存与新增断言不一致的 2 项。后三项在冻结代码后单独复测全部通过，未降低断言或增加超时。
这不等于宣称全仓测试全绿。初始默认高并发 `npm test` 的更多超时已另行低并发复核，见验证报告。

`npm test` 后续的 standalone 分组也单独执行，避免前置失败让 `&&` 后的测试被跳过。
workflow 分组的既有 `pwd -W` Bash 假设在 PowerShell 下失败；后续脚本另行补跑，结果详见验证报告。
全仓 lint 中大量是 CRLF/旧格式警告，另有旧组件 Hook 规则、CJS 夹具、未使用变量等错误；未通过批量格式化掩盖。

## 性能和影响范围

64 步编辑器浏览器交互 p95 约 21 ms；这是当前受控浏览器信号，不是与旧版本严谨对照的提升百分比。
64 步、256 次受限执行的宿主内存基准：保存 p95 约 0.63 ms，执行累计约 349 ms，约 1.36 ms/次。
此基准不含 SQLite、项目扫描、真实模型或工具耗时，详见 `output/mods-composition-performance.log`。

最终 Electron 真实 IPC、两个小型已批准插件、warm runtime，各测 10 次：`clawView` p50 56.11 ms、
p95 56.71 ms；`flowCatalog` p50 54.80 ms、p95 55.62 ms。前后 guest 调用计数不增加，确认读取不执行动作。
这是小样本本机结果，不代表大型插件或大工作区，也不是改前改后提速比较。

普通 Mods 对话为了显示当前绑定会读取 `clawView` 和运行状态，不能沿用旧报告“导航零 Flow IPC”的结论。
会话运行路径使用绑定缓存；侧栏详细目录按需加载，读取不执行动作。大型插件或大量会话下仍有进一步拆分轻量
绑定读取接口的空间，应依据真实测量决定，不把这项描述成已经优化完成。

无 Claw 模型策略时保留原模型路由；Mods 关闭时不会应用 Claw 默认模型。传统 Plugin/Harness、远程、定时等
非普通本地对话不应用本轮绑定。组织保护、项目强制完成规则与旧工具授权继续生效。

## 尚未实现的部分

本轮主要 DIY 链路已落地，但不等于“一切皆模组”，也不宣称与 Claude Mods / DeepSeek Harness 全面等价。

1. 动作需要作者显式导出；不能自动拆解任意插件内部函数。启用提供者仍会注册整包原有 Hooks，尚未实现按组件卸载其余 Hooks。
2. Skill、MCP、内置工具尚未全部成为 Claw 可独立选择并隔离的同一种组件；loop、存储和沙箱尚不能通过此界面任意替换。
3. 动作配置目前使用 JSON，输出绑定使用对象/JSON Pointer；没有自动生成所有 schema 表单或任意表达式连线。
4. Agent 的模型角色与插件的 `config.model` 参数是不同契约。节点显示“步骤绑定模型”不代表其他 Mod 从未覆盖最终请求；示例输出模型同样只是请求值。
5. Flow 固定整次执行的模型计划；普通主请求和每次独立插件模型调用分别校验。普通聊天所有嵌套调用尚未统一成一份整 turn 模型快照，调用间主动修改配置可能被后一次调用捕获。
6. 完成规则仍为项目共享设置，不随 Claw 保存独立副本；安全撤权即时生效。进程重启后的未完成 Flow 标为 interrupted，不自动重放副作用。

这些边界不会阻止本次 Autobiz → 独立 Review → 人工确认的组合体验，但应在汇报“完成程度”时明确说出。

## 真实界面

截图来自最终生产 Electron 构建和隔离测试项目，不是原型稿。1366 宽度并排展示聊天与侧栏；
1024/800 使用覆盖抽屉，会遮住输入框一部分，收起后恢复完整聊天，不能描述成窄屏同时完整显示两栏。

- [已应用双插件、默认与角色模型](../output/mods-composition-e2e/configuration-sidebar.png)
- [实际等待审批的侧栏](../output/mods-composition-e2e/approval-sidebar-1366.png)
- [Claw 组合编辑器](../output/mods-composition-e2e/claw-binding-editor.png)
- [800 宽度抽屉](../output/mods-composition-e2e/approval-sidebar-800.png)
- [普通聊天使用绑定默认模型](../output/mods-composition-e2e/bound-default-model-chat.png)

## 资料入口

- [实际使用手册与两个安装包位置](mods-composition-hands-on-2026-09-29.md)
- [插件作者动作协议](mods-claw-action-authoring.md)
- [原始调研与差距方案](mods-composition-gap-and-sidebar-plan-2026-09-29.md)：这是实现前状态，不应继续拿其中“未实现”表当当前状态。
- [架构评审与实现复核](mods-composition-architecture-review-2026-09-29.md)
- [交互评审及浏览器验证](mods-composition-quality-review-2026-09-29.md)
- [独立回归与基线问题](mods-composition-verification-plan-2026-09-29.md)
