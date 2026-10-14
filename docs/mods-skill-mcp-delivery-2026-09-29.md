# Claw 多来源组合迭代交付与复核

最新进展：Skill / MCP 已可作为原生流程步骤，详见
[原生步骤交付说明](mods-native-step-delivery-2026-09-29.md)。本文保留上一轮历史记录。

日期：2026-09-29。开发目录 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。本轮未改 UAT，未提交或推送。

## 本轮效果

在已有跨插件动作、模型角色、流程副本基础上，“我的 Claw”现在能独立选择已安装 Skill 和已配置 MCP 服务。选择落实到会话运行入口，保存模板不自动改动已应用的会话。

例如：选择 Autobiz 的需求分析技能、Review 插件的评审能力、一个代码仓库 MCP 服务和评审模型，再保存并应用到当前对话。普通聊天使用这些已选能力；需要固定顺序时，仍由显式流程安排插件导出的动作。模型不会因为勾选某个 Skill 就必然执行它，勾选也不会自动生成业务流程。

每类提供两种方式：

- **沿用已启用来源**：保持旧行为，新装并启用的来源也可参与。
- **仅使用所选**：固定所选身份与版本；空选代表不提供本类宿主能力。“全选当前”是固定当前名单，之后新增不会自动加入。

MCP 按服务选择其全部可用工具；不同插件的 Skill/MCP 可以混合选择。选择与原有启用状态、授权取交集，不能重新启用被全局禁用的来源。更改 SKILL.md、MCP 配置、卸载或禁用来源后，使用旧组合会被拒绝，需要重新核对。

## 实际使用

1. 在“技能”“MCP 连接器”“插件”中安装、配置并启用所需来源；Function Mods 仍需原有授权。
2. 打开带项目目录的普通会话，右侧 **Claw 工作台 → 配置 → 编辑我的 Claw**。
3. 给组合命名，选插件与模型。在 **技能 Skill**、**外部工具 MCP 服务** 分别选择“仅使用所选”，勾选来源。
4. **保存版本**，再点该版本的 **应用到当前对话**。这两个操作不会启动任务。
5. 回到聊天输入具体目标。显式插件命令仍用 `/命令`；Skill 可通过已有技能选择入口触发；MCP 由助手按任务调用。固定步骤任务使用已绑定流程的执行入口。
6. 查看右侧组合摘要、实际工具调用和运行结果。修改模板后，需再次应用；其他已绑定会话保持各自副本。

编辑页显示当前绑定副本，后台刷新不覆盖手动草稿。目录读取失败会提示重试，失效项保留并允许移除，不按同名自动替换。来源列表每批显示 100 项，搜索覆盖完整目录。

## 双评审与发现的问题

实施前架构和质量两位 agent 均通过 [实施契约](./mods-skill-mcp-implementation-contract-2026-09-29.md)。独立复核和真实 Electron 发现的问题均作为验收阻断处理：

1. MCP 独立插件命令拥有单独的冷启动适配器。仅保护普通 runtime 不够；现已同步保护该入口和冷权限查询。
2. deepagents 技能中间件直接信任 checkpoint 的旧技能清单。现由本工程包装中间件，从受限 backend 重建当前目录，并在模型调用边界复核来源。
3. 独立原生工具命令、Flow root backend 也单独创建 LocalSandbox。已传递相同 Skill policy、生命周期注册表和作用域。
4. 新增嵌套技能、路径别名、Hook 执行期间改变文档，需要使用前后复核，不能只验证编辑页。
5. 来源显示名称与宿主身份校验不一致会导致保存成功而运行失败，现保存/应用使用相同身份约束。

评审明细：[架构](./mods-skill-mcp-composition-architecture-review-2026-09-29.md)、[质量](./mods-skill-mcp-quality-review-2026-09-29.md)、[Skill 验证](./mods-skill-backend-verification-2026-09-29.md)。

## 验证记录

最终代码已完成两位 agent 的独立复核。构建及 Node/Web TypeScript 均退出 0。

| 验证 | 最终结果 | 证据 |
| --- | --- | --- |
| 全仓 Vitest，冻结代码后 `--maxWorkers=2` | 674 文件；5316 通过、11 失败、5 跳过 | `output/claw-sources-final-full-vitest.json` |
| 上述最终全仓结果中的 `test:mods` 范围 | 199 文件、1790 项全部通过 | 同一 JSON，按 npm 脚本范围统计 |
| 关键新增/受影响链路定向复跑 | 12 文件、90 项通过 | `output/claw-sources-final-focused.log` |
| 新来源组合真实 Electron | 7 组通过，页面异常 0；包含真实 QuickJS、双 stdio 服务、模型请求、Flow 子任务、刷新持久化 | `output/mods-claw-sources-e2e/report.json` |
| 原跨插件组合 Electron | 11 组通过 | `output/mods-skill-mcp-regression-e2e-results.json` |
| 原 Flow Electron | 9 组通过 | 同上 |
| 传统 Plugin / Harness Electron | 7 组通过 | 同上 |
| 交互浏览器检查 | 19 组通过，含空选、失效来源、草稿保护、600 项分页搜索 | 质量评审报告与 `output/mods-source-browser/` |
| npm test 后续 9 组 standalone | 8 组通过；workflow 保留 `pwd -W` 在 PowerShell 的基线失败；被阻断的后续 25 脚本均补跑通过 | `output/mods-skill-mcp-regression-summary.json` |
| ESLint | 本轮增量定向检查通过；全仓 quiet 检查仍有 100 个既有错误，未称全仓 lint 通过 | `output/claw-sources-root-lint.log`、`output/claw-sources-full-lint.json` |
| `git diff --check` | 退出 0 | Git 的 LF/CRLF 提示不属于 diff 错误 |

全仓 11 个失败与上一轮记录一致：`open-in-ide.test.ts` 的 5 个 macOS 路径模拟在 Windows 失败；Chrome 扩展 popup/service-worker 的 5 个用例缺源码文件；theme-surface-policy 的 1 个 Windows 路径基线问题。本轮没有修改这些生产模块，也没有通过跳过测试掩盖失败。因此不能表述为 `npm test` 全绿。

本轮还修复两处上一轮交互调整遗留的测试适配：composer AST fixture 缺少 `flowIntent` 状态（保留原 7 项守卫断言并新增流程守卫检查，共 8 项通过）；队列源码断言没有识别 Claw 默认模型优先级（修正后原 52 项通过）。没有修改生产守卫来迎合测试。

首次全仓运行与代码修复重叠，出现共享模块转换缓存与新断言版本不一致；该次结果仍保留在 `output/claw-sources-full-vitest.json`。交付结论采用冻结后的完整复跑，不使用首次结果冒充全绿。

真实 Electron 截图：[Skill 选择](../output/mods-claw-sources-e2e/skill-selection.png)、[MCP 选择](../output/mods-claw-sources-e2e/mcp-selection.png)、[800 宽度](../output/mods-claw-sources-e2e/skill-selection-800.png)。MCP 来源展示插件名称，不显示内部 UUID。

## 性能和边界

- `clawView` 不增加来源扫描；仅打开编辑页读取独立来源目录。MCP 目录读取不连接服务；MCP 空选不初始化服务。
- Skill 来源列表涉及真实文件、摘要和当前禁用状态，存在成本。512 个小 Skill 的专项结果见 Skill 验证报告；不在每个 token 扫描。模型请求边界只校验已选身份，避免每个文档再次遍历整个注册目录。
- 冻结后可复现脚本 `npx tsx tests/mods-claw-sources-performance.spec.ts`：512 个本地小文件目录读取 467.53ms，policy 创建 709.81ms；5 次模型请求边界校验中位 297.70ms，仅发生 2 次目录发现（建目录/建 policy），后续不重新发现。缺省/all 两次调用合计 0.26ms、扫描 0 次。机器、文件大小与负载会影响结果，不能称整体推理加速。数据在 `output/mods-claw-sources-performance.json`。
- 真实 Electron 小目录 5 次来源 IPC 为 18.04–83.47ms，中位 24.22ms，包含文件扫描；此数据不能外推大项目或远程服务性能。
- MCP 运行复用全局连接池，初始化仍可能连接其他已启用服务；本轮保证未选服务不获得本会话的工具调用，不保证连接/进程隔离。
- Skill 选择约束宿主技能目录、生命周期、显式激活与原生结构化读取。它不是 OS 文件沙箱，不限制普通 shell 读取绝对路径、用户复制文本或插件现有 `$.fs` 通用权限。
- Skill 摘要固定身份与 SKILL.md，不固定所有附属文件。MCP 摘要固定宿主配置，不保证远端服务实现不变。
- 斜杠菜单当前仍是全局列表，可能显示未选技能；真正发送时由宿主拒绝。为避免同名技能被误匹配，本轮没有使用名称过滤冒充精确来源映射。
- 切换组合会刷新新的能力清单，不删除历史对话中已经出现的技能说明、工具结果或用户粘贴的内容。

## 距离全面对齐还有什么

| 目标 | 当前状态 |
| --- | --- |
| 跨插件动作、默认/角色模型、会话副本 | 上一轮已完成，本轮回归 |
| 跨插件 Skill / MCP 服务组合并实际约束调用 | 本轮实施和验证 |
| 把每个 Skill / MCP 单工具直接拖入固定流程成为独立节点 | 本轮没有提供通用转换器，流程仍要求已有节点协议/导出动作 |
| 拆分同一 Function 插件内部任意 Hook 开关 | 尚未形成通用组件卸载机制，选择插件仍按完整插件生效 |
| 任意内核、权限引擎、调度服务替换 | 尚未完成；不能用配置界面等同于内核可替换 |
| Claude 任意版本所有内部 Mods API 完全兼容 | 不承诺；已验证版本与公开/本地参考必须分别列证据 |

官方 [Mods README](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/README.md) 描述 hook 注册及 engine interface；本轮读取的 [公开类型](https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts) 标注 2.1.277，既有本地反编译参考为 2.1.283。本工程的可视化 Claw 组合是产品实现，不能据此声称 Claude 具有相同页面或相同操作方式。

相关上一轮交付：[多插件组合](./mods-composition-delivery-2026-09-29.md)、[Autobiz 实际使用](./mods-composition-hands-on-2026-09-29.md)、[动作开发协议](./mods-claw-action-authoring.md)。
