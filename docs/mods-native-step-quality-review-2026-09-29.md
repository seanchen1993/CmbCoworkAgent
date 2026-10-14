# 原生 Skill / MCP 步骤质量评审

## 最终结论：通过，无残余阻断

最终只读复核真实执行证据与最后的使用说明修复后，本轮“Skill + 模型 → MCP 工具 →
插件动作”契约达到交付要求。此结论限定于已实现的普通本地项目流程，不宣称完全复刻
Claude 官方界面或协议，也不承诺模型确定性遵循指令、MCP 连接隔离或远端操作可回滚。

本次评审以 `mods-native-step-contract-2026-09-29.md` 为准。扩展既有流程和所属
Function Mod 授权，不另造任务执行器，不改变普通 Plugin/Harness 默认行为。
Skill 节点必须真正进入显式技能激活生命周期；只把技能文字放进提示词不算实现。
MCP 节点须走宿主 scoped MCP 权限、审计与内容保护链；UI 目录不构成调用授权。

必须满足的边界：

- 来源仅保存宿主身份和摘要，不能传入路径、凭据或 transport 配置。
- 模型选择同时适用于 Agent 与 Skill，结果称“步骤绑定模型”，不冒充最终供应商。
- MCP 目录由用户显式加载，编辑器或侧栏挂载不连接服务。按钮披露全局初始化可能
  连接其他已启用服务；不支持的高级 schema 单项禁选，不掩盖其他可用工具。
- MCP 禁止本节点业务回退，也禁止任意后续节点回退跨过已启用 MCP；仅禁止自身
  onFailure 不足以防止重复调用。运行层仍需单次调用防线，错误/取消/重启不重放。
- 仅 plugin-action 和 mcp-tool 产生可引用的结构化输出；Skill 普通文本不能假装是对象。
  仍须验证上游最新通过且未失效、JSON Pointer 目标是对象、固定输入覆盖同名字段。
- 目录 IPC 要在 await 两侧验证线程/项目/绑定。UI 另有请求代际：换线程、项目刷新、
  configurationChanged 均废弃迟到结果。刷新不修改当前保存的来源选择。

## 已落地的编辑与校验

步骤组件库增加 Skill 任务与 MCP 工具。Skill 可选择同名但不同来源的技能、任务、
Agent 角色和模型。MCP 可手动加载目录、查看参数格式、填对象输入、引用前序输出。
已保存来源保持原身份，失效后由宿主拒绝运行，不偷偷换成同名的新版本。
旧 schemaVersion 1 流程保持兼容，新增计划和运行记录字段为可选扩展。

共享 schema 严格重建新节点，丢弃 renderer 额外提供的路径、配置和 schema。
失败路线编辑器禁选跨 MCP 的回退目标，保存端再次校验，不能靠手工构造绕过。
MCP 结果显示服务与工具身份，Skill 结果显示技能来源。

## 已执行验证与交付门槛

- 共享 Flow 测试 23 / 23 通过，含新增 9 项：保存重读身份、输入复用、额外字段丢弃、
  非法摘要/JSON/指针、上游类型/顺序/禁用、MCP 自身重试与跨节点回退、旧合法回退。
- 真实 React/浏览器新增链路通过：Skill + 模型、手动目录与不支持项禁选、MCP 输出接
  插件动作、非法 JSON 阻止保存、保存 payload、普通刷新零连接、配置变更和换线程迟到响应。
- 完整浏览器 20 组通过，64 步编辑 p95 16.5 ms；定向 ESLint 与 web typecheck 通过。
  新节点截图位于 `output/mods-native-steps-ui/`，真实样式已目视核对。
- 第二位架构 agent 独立复核 shared/schema/UI 通过，无阻断；已保存来源与目录相同项
  的重复 option 属轻微交互余项，不影响身份校验。Skill 激活仍由模型执行指令，不能
  保证模型必定读完整内容或遵守每一条指令，不能宣传为确定性函数。
- 独立复核 root 的 IPC/Claw 接线通过：source 目录按当前绑定完整身份过滤；手动 MCP
  发现前后检查线程 incarnation、工作区和绑定版本；启用的原生步骤检查来源与模型，
  禁用步骤不阻断旧组合。追加两项 handler 反例测试证明禁用来源零解析、同名不同
  provider ID 不可替代；Claw IPC 12 + Flow IPC 20 共 32 项通过，定向 lint 通过。
- 读取生产 Electron 新链路 `output/mods-claw-sources-e2e/report.json`：10 组通过、
  errors 为空，真实 Skill 指令读取与 Pre/Post Hook、PreSkillUse 阻断零模型请求、
  MCP 一次调用、QuickJS 后续动作接收结构化输出、绑定与刷新持久化均有实测证据。
- 读取旧 Flow 9 组、旧组合 11 组、传统 Plugin/Harness 7 组日志，均通过；加新链路
  共 37 组。真实 MCP helper 保留 ModCallContext、owner grant、内容保护与审计，
  精确工具调用有 schema/来源/连接版本检查。新增 runtime-host-lifecycle 捕获真实
  child authority，在 Hook await 前后校验，撤销后不能按 agent 字符串重新获得权限。
- 旧功能 standalone 8 组直接通过；workflow 保留已知 PowerShell `pwd -W` 基线失败，
  Git Bash 原测试复验通过，后续被阻断的 25 个脚本补跑全通过。详见
  `output/native-steps-standalone-summary.md`。
- 最终发现并关闭使用说明问题：去除旧“四类步骤”限制，说明原生来源和输出连接，
  明确应用组合后需切换“执行流程”，普通聊天不会启动流程。真实 browser 断言先复现
  缺失说明失败，修正后 fresh native-only 通过；同时断言全部 7 类组件可见、手动加载
  与不可回退说明。证据 `output/native-steps-guide-browser-final.log`。

剩余限制均已披露：高级 MCP schema 暂不可选、服务初始化可能打开其他全局已启用连接、
全局 Skill slash 菜单仍可见但宿主拒绝未选来源、Skill 指令由模型执行。没有需阻止本轮
交付的未解决问题。最终全量 Vitest 与构建结果仍以主任务冻结后的汇总为准。
