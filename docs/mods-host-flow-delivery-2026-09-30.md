# 无所属插件流程：使用与交付记录

后续进展：组件级选择已进入下一轮实现，参见
[组件级 DIY Claw 交付记录](mods-component-selection-delivery-2026-09-30.md)。本文保留宿主流程这一批次的验收边界。

开发目录 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。UAT 未修改。
本轮实现下一阶段中的“流程独立运行”，组件级拆分尚未实现。
专项与 Electron 验收已完成。全量 Vitest 已完成，失败用例与历史基线一致；
九条独立回归链全部通过，没有新增失败用例。全仓仍有 11 项历史失败，不能称为全绿。

## 使用上有什么变化

以前创建流程必须先安装和授权一个 Function 插件，再选为“所属 Mods”。即使只想使用模型、
Skill 或 MCP，也需要这个前置步骤。现在新建代码检视流程默认由应用运行，没有所属插件下拉框。
没有任何插件包，也可以保存、绑定 Claw 并从聊天执行。

“没有所属插件”不表示没有权限检查。MCP 的真实工具调用、项目测试命令仍需通过原来的运行限制、
操作审批、内容保护和审计；插件动作仍需授权其真实来源。

| 能力 | 新建通用流程 | 原有插件所属流程 |
| --- | --- | --- |
| Agent/模型、Skill、MCP、人工确认 | 支持，不需安装 Function 包 | 保持支持 |
| 跨插件动作 | 使用已授权且在当前 Claw 中选择的来源 | 保持原规则 |
| 原生单元测试、E2E 检查 | 支持，保留真实执行回执并在最终完成前复验 | 保持原规则 |
| 代码评审 | 使用 Agent 步骤，不将模型结论称为测试证明 | 原有检查入口保留 |
| Autobiz 验证和阶段推进 | 使用原有 Autobiz 流程入口 | 保持插件授权与阶段证明 |

没有执行中的真实测试回执，不能产生通过证据。取消、授权变化、来源更新或关闭 Mods 后，
旧确认按钮不能继续执行或发布成功结果。

## 从零体验

1. 打开普通本地项目会话，开启 Mods。无需先上传 Function 插件。
2. 进入 DIY 流程，点击“新建代码检视流程”。填写目标；模板已有“检视代码”和“确认检视结果”。
3. 在 Agent 步骤选择已配置模型，或使用当前 Claw/会话默认模型。需要 Skill/MCP 时添加对应步骤；
   MCP 工具需显式加载目录，打开编辑页面本身不会连接所有服务。
4. 项目已经声明测试脚本时，可添加“真实检查”，选择单元测试或 E2E。没有脚本时应先配置真实测试，
   不能把 Agent 说“测试通过”当作执行结果。
5. 保存流程。可以直接运行已保存版本，也可以在“我的 Claw”选择该流程，保存并应用。
6. 回到聊天，将输入方式切到“执行流程”，输入本次目标并发送。保存或应用本身不会执行。
7. 在右侧查看步骤进度、结果和人工确认；取消后不会自动重放未完成操作。

已有 Autobiz 用户：继续使用“从 Autobiz 模板创建”，显式选择已有的授权插件；旧流程不自动转换。
你仍可在流程中加入另一个插件的检视动作和不同模型。移除“所属插件”与把插件拆成独立组件是两项能力，
本轮完成前者，不能据此认为原有整包 Hooks 已按动作隔离。

## 底层和兼容策略

- 新定义使用 schemaVersion:2 与 execution:{kind:"host"}；禁止伪造 plugin、grant 或 owner 字段。
  旧 schemaVersion:1 仍必须有 plugin，保持原规范化顺序、摘要、revision 和绑定副本。
- HostFlowAuthority 是只存在于宿主内存的执行对象，绑定工作区、对话、运行租约、物理 runtime、
  定义摘要、开关 epoch 及取消信号；不创建假的 Function 授权记录，也不能经 IPC 序列化复制。
- 原生 MCP 继续固定服务、工具、schema 和连接身份，只能实际运输一次，不自动重试外部操作。
- 宿主操作确认框显示“批准流程操作”，不再把流程运行身份显示为插件。工具目标仍保留实际
  capability ID；MCP 目标中的连接器 ID 不是流程 ID，后续可再统一友好名称展示。
- 原生检查走原生产执行器，保留命令最终参数校验、审批、进程树约束和持久化回执；前后产物变化
  使证据失效。流程最终复验已有检查，并继续执行当前应用完成规则。
- 代码检视期间修复了宿主存活校验递归、无保护模式审计未标记已发布，以及合法嵌套插件调用
  被父级环境身份误拒的问题。原始失败和修复后记录保留，没有移除审批或放宽通过断言。
- 首次 Electron 复现：等待确认时更新 Skill，旧确认被拒后运行仍占用租约。本轮修复有效性检查
  失败后的终止、清理和租约释放；过期 nonce 与并发重复确认不会误停有效运行。

设计和独立评审：[实施契约](mods-host-flow-contract-2026-09-30.md)、
[架构评审](mods-host-flow-architecture-review-2026-09-30.md)、
[质量评审](mods-ownerless-flow-quality-review-2026-09-30.md)。

## 验证记录

| 验证 | 当前结果 |
| --- | --- |
| schema、存储、Claw 与 Flow IPC | 5 文件、67 项通过，包含 v1 固定字节与混合版本重启 |
| scope、原生执行器与 MCP | 3 文件、76 项通过，包含真实 stdio、失效身份、检查证据和最终复验 |
| 宿主权限专项 | 8 项通过，包含真实项目测试、拒绝审批、伪造 token、租约变更、取消及执行成功后发布期间撤权 |
| 流程执行管理 | 30 项通过，包含来源失效即时清理、旧 nonce 保留等待、并发确认单次消费；新增反例在修复前失败 |
| 旧工具能力 | 52 项通过，覆盖原生执行、后台任务、撤权、阶段回调和旧 Function 授权 |
| 浏览器 | 新宿主流程 5 组、原 Flow 20 组、参数表单 8 组，全部通过 |
| 类型与构建 | 最终 Node/Web TypeScript、生产 build 通过 |
| Electron | 6 个脚本、51 组通过：宿主流程 9、旧 Flow 9、组合 11、传统 Plugin/Harness 7、Skill/MCP 10、参数表单 5 |
| 全量 Vitest | 684 文件：680 通过、4 失败；5,526 项：5,510 通过、11 失败、5 跳过；627.82 秒 |
| 独立回归链 | adoption、messages、hooks、plugins、task-cards、merge、workflow、desktop-agent-baseline、im-v1 九条全部退出 0 |

全量命令 `npm test` 的退出码为 1，不能宣称全仓全绿。11 项失败与之前记录的基线逐项一致：
macOS JetBrains 打开 IDE 5 项、Chrome 扩展 5 项、主题固定颜色约束 1 项，没有新增失败用例。
主题检查仍报告 22 处已有样式问题，未涉及本轮新增的流程页面。
对照记录见 `output/mods-host-flow-baseline-comparison.json`，原始日志为
`output/mods-host-flow-npm-test.log`；历史基线来自
`output/claude-code-2.1.284-analysis/full-vitest.json` 和前轮逐项对照记录。
原命令通过 `&&` 串联后续九条回归链，因 Vitest 非零而未自动运行，因此另行顺序执行原命令。
九条链包含 84 个原始子命令，使用 Node 22.23.2；工作流链设置 Git Bash，满足已有 Windows
测试中的 `pwd -W` 前提，没有修改测试断言或生产行为。工作流引擎 96 项、worktree 66 项、
本地工作区隔离、桌面 Agent 和 IM 模拟完整旅程均通过。逐链退出码和日志见
`output/mods-host-flow-standalone/report.json`。

本机截图：[无插件的 800px 编辑页面](../output/mods-host-flow-browser/zero-plugins-800.png)。
真实 Electron：[无所属插件编辑器](../output/mods-host-flow-validation/host-complete/host-no-plugin-editor.png)、
[聊天运行完成](../output/mods-host-flow-validation/host-complete/host-no-plugin-complete.png)。
完整过程、隔离模型/进程证据与测试边界见 [独立 Electron 验收](mods-host-flow-electron-verification-2026-09-30.md)。
实际 Electron 的宿主流程和参数表单已在最后审批文案构建上复测；旧四套回归是在只相差审批文案的
上一构建通过，运行逻辑一致。原始结果见 `output/mods-host-flow-validation/results.json`。
审批文案验证两次修正测试定位：连接器 UUID 不是流程运行 ID，MCP 精确目标含 `connector:` 前缀；
最后断言同时确认“批准流程操作”、无插件冒充、无流程 ID 和正确工具目标，没有删除审批断言。
测试产物在 `output/mods-host-flow-*` 和 `output/mods-ownerless-*`，不作为源码提交。

性能观测：旧流程浏览器回归记录 64 步编辑器交互 p95 为 16.7ms，导航不发起 Flow IPC，
256 次尝试的详情按边界渲染。受控 Electron 小项目从聊天发送到首次人工确认约 11.41 秒，
包含模型 HTTP、MCP 与 npm 子进程。这些是本机自动化场景记录，没有同负载前后对照，
不能宣称性能提升，也不能外推到线上模型或大型工作区。

## 尚未完成与下一步

- 组件级自由选择：当前旧插件仍整体加载。下一步需要作者声明组件、依赖和入口，再贯通选择、
  授权、加载、撤权、快照与审计，不能仅隐藏未选 Hook。
- 传统 Plugin/Harness 的 Flow 接入：已提前核查，仍需显式 adapter 桥接；本轮不解除普通本地
  会话限制，不改变原 Harness 的项目身份、调度、产物授权和阶段证明。
- 插件升级修复引导、项目规则与 Claw 附加规则隔离、完整 Skill 正文扩展及其他兼容 API 仍待迭代。
- 不支持任意副作用事务恢复；重启后中断运行不会自动续跑未知操作。

本轮不宣称全面对齐 Claude，也没有重新核验新发布的 Claude 版本。
