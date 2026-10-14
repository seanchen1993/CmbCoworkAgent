# DIY Claw 原生 Skill / MCP 步骤交付说明

开发目录：`C:\ai\CmbCoworkAgent-mods-v2`，分支：`codex/mods-v2`。

## 这轮解决什么问题

前一版“我的 Claw”选择 Skill/MCP，控制的是对话可以使用的能力范围。
这轮在 DIY 流程中增加独立的 **Skill 任务** 和 **MCP 工具** 步骤，可以明确规定执行顺序。

例如：用插件 A 的需求 Skill 和模型 X 分析任务 → 调用服务 B 的查询工具 →
把查询结果交给插件 C 的导出动作 → 用模型 Y 做评审 → 人工确认。
Skill、MCP 和动作可以来自不同已安装来源，但都必须在当前 Claw 范围内并保持授权有效。

Skill 步骤由模型根据技能指令执行；它不是把 Markdown 变成确定性程序。
MCP 步骤由宿主精确调用指定工具，参数由用户配置，不要求模型先决定调用哪个工具。

## 实际使用

1. 在普通本地项目会话打开右侧 **Claw 工作台**。通过现有 Plugin 上传/安装入口安装技能或插件，
   在连接器或插件 MCP 配置中启用服务；上传文件本身不会自动获得运行授权。
2. 在“我的 Claw”选择允许的 Function Mods、Skill、MCP 和模型，保存并应用到当前对话。
3. 进入 **DIY 流程**，新建或编辑流程，保留一个已授权的“所属 Mods”作为流程运行授权来源。
4. 添加 **Skill 任务**，选择技能，填写本步骤目标，选择模型或模型角色。
5. 添加 **MCP 工具**，手动点击“加载 MCP 工具目录”，选择具体服务和工具。查看参数说明，填写
   JSON 对象。加载目录会连接服务；仅打开页面不会自动连接 MCP。
6. 后续插件动作或 MCP 工具可选择“接收前置步骤输出”。例如读取 MCP 的结构化结果使用
   `/structuredContent`；固定输入覆盖同名字段。所引用部分必须是对象，标量不能直接用作整个参数对象。
7. 保存流程。在“我的 Claw”选择该已保存流程，再保存并应用组合。回到聊天切换到 **执行流程**，
   输入本次任务并发送，由绑定的流程执行。**普通聊天**不会启动流程；也可在 DIY 流程页直接运行已保存版本。

编辑模板不会悄悄更新已应用的组合副本；要使用新版本，需要重新选择保存后的流程并应用组合。
历史中会记录实际 Skill、模型、MCP 来源、工具、输入 schema 摘要和步骤结果。

## 界面示例

![Skill 任务配置](../output/mods-native-steps-ui/skill-step.png)

![MCP 工具配置](../output/mods-native-steps-ui/mcp-step.png)

## 行为边界

| 项目 | 当前行为 |
| --- | --- |
| MCP 失败或断线 | 不自动重发；失败回退不能跨过已配置的 MCP 步骤 |
| 取消 | 停止继续执行，不承诺已发送到远端的操作可以回滚 |
| 来源更新/禁用 | 在运行和发布边界重新核验；旧引用失效时重新选择来源并保存 |
| Skill 校验 | 固定 SKILL.md 与来源身份；辅助文件不做整个目录内容快照 |
| Skill Hook | 走前置激活与成功完成后的 PostSkillUse；取消或异常不承诺执行完成 Hook |
| MCP 输出 | 保存经过内容保护的 text、structuredContent、isError；不把原始图片/二进制写入流程输出 |
| MCP schema | 支持严格基础 JSON Schema 子集；不支持的高级定义显示不可用原因 |
| MCP 连接 | 使用共享连接池，能力选择限制调用，不是独立进程隔离 |
| 传统用户 | 未使用新节点的定义、未应用 Claw 的对话继续使用原有路径 |
| 工作模式 | 本页编排仍限普通本地项目会话，未将 Harness/远端模式强行转换为新流程 |

## 与最终对齐目标的距离

本轮打通用户最直观的“技能 + 模型 + 外部工具 + 跨插件动作”步骤组合。
仍不应称为 Claude Mods 全面一比一兼容：可视化 Flow 是本工程扩展；任意 Hook 拆分成可拖拽组件、
替换整个 Agent 内核、无所属 Function Mod 的独立流程，以及任意复杂 MCP schema，未在本轮实现。
本轮没有重新反编译或验证更新后的 Claude 发布版本；官方和反编译依据沿用前期调研的明确版本。

## 评审与验证

设计契约及两个 agent 评审：

- [实施契约](mods-native-step-contract-2026-09-29.md)
- [架构评审](mods-native-step-architecture-review-2026-09-29.md)
- [质量与交互评审](mods-native-step-quality-review-2026-09-29.md)
- [Skill 后端与性能验证](mods-native-skill-verification-2026-09-29.md)

最终验证记录：

| 范围 | 结果与证据 |
| --- | --- |
| 最后一次运行链路回归 | 210 文件 / 1,886 项全部通过，`output/native-steps-final-regression.json` |
| 新能力 Electron E2E | 10 组全部通过，`output/mods-claw-sources-e2e/report.json`，页面错误为空 |
| React 界面验证 | 完整浏览器回归 20 组通过；最终说明文案追加原生步骤专项复验通过，`output/native-steps-guide-browser-final.log` |
| 旧功能 Electron E2E | 旧 Flow 9 组、跨插件组合 11 组、传统 Plugin/Harness 7 组全部通过 |
| 全量 Vitest | 677 文件：5,360 通过、13 失败、5 跳过，`output/native-steps-full-vitest.json` |
| 全量失败复核 | 11 项与上一轮失败名称逐项相同；另两项浏览器时序与 Windows 文件占用，独立复跑 2 文件 / 16 项全过 |
| Standalone | 9 组中 8 组通过；workflow 的既有 PowerShell `pwd -W` 失败在 Git Bash 原测试通过；后续 25 脚本补跑全过 |
| TypeScript / 构建 | 类型检查通过；生产包构建通过，日志 `output/native-steps-typecheck-final.log` / `native-steps-build-final.log` |
| 增量代码规范 | 各实现分工与集成文件定向 ESLint 通过；未宣称仓库历史全量 lint 全绿 |
| 性能 | 512 个小 Skill 文件中，64 步骤同来源准备约 519 ms，只扫描目录一次；64 pin 复验中位约 40 ms |

全量 Vitest 在最后的子运行作用域修复之前启动，随后对最终代码执行上表 1,886 项完整功能子集回归。
没有把两次测试合并伪报为一次全绿。基线 11 项涉及 macOS IDE 路径测试、缺失 Chrome 扩展文件及
Windows 下主题路径规则，详见原始 JSON。Standalone 逐项结果见 `output/native-steps-standalone-summary.md`。

首次新链路 E2E 发现 Skill 准备回调缺少子运行作用域，触发 `MODS_THREAD_CONTEXT_REQUIRED`。
已改为由实际 runtime 交付仅宿主持有的生命周期调用能力，保留 authority/撤权检查；新增真实
非 main 绑定回归后，重建并重跑 E2E 全部通过。未通过放宽权限、跳过 Hook 或更改期望掩盖失败。

测试中的受控模型不能替代真实业务模型和企业网络验收。性能是本机小文件测量，不代表模型推理加速。

前期完整能力及来源选择说明见 [上一轮交付报告](mods-skill-mcp-delivery-2026-09-29.md)。
