# 用户直接技能选择的展开检查（2026-09-23）

`classic.UserPromptExpansion` 在原显式技能解析确认有效且启用后、PreSkillUse 激活前执行，沿用原 runHooks → ModsManager → FunctionSession。host v50；已有授权摘要需要重新批准。

用户直接选择技能时，检查可以返回 `block` 阻止模型请求，或 `additionalContext` 字符串数组补充本轮上下文。普通消息、模型调用技能工具和 Function Mod 的普通 command.run 不触发。经典 settings Hook 使用 `decision: "block"` / `reason`，`matcher` 匹配已解析的技能名；设置 async 也必须等待门禁。`next` 多次调用不会重复执行 legacy core。

字段来自真实选择：`command_name` 是 registry 解析名称；`command_args` 是技能标记之前的消息正文；`command_source` 为 plugin 或 local；`expansion_type` 为 slash_command；`prompt` 为原始输入。来源身份不可被模块下游改写。JSON 输入遵守现有有界传输约束。

配置入口：Hooks → 新增 → 技能提示展开前；可按技能名匹配。关闭 Mods 后原技能准备流程继续执行；独立配置的经典 Hook 仍按其自身开关执行。模块没有注册处理器时不额外调用模型。

运行结束、取消或撤权不能把迟到检查结果注入下一轮；准备流程在激活前后验证当前运行。检查被阻止时显示原因，原阻止提示不回显用户原文。

## 与最新 Claude 语义的差异

对照 [官方 UserPromptExpansion](https://code.claude.com/docs/en/hooks#userpromptexpansion)，矩阵标为 adapted。本工程使用桌面技能选择标记或宿主确认的传输技能选择，随后由原模型读取 SKILL.md；不是把上游 slash 命令解析器复制进来。保留本工程既有 PreSkillUse → UserPromptSubmit 的后续顺序。本次不覆盖 MCP prompt、任意自定义 prompt 命令、子 Agent 或上游所有 command_source 分类。不能仅凭相同事件名宣称完整兼容。

验证覆盖真实安装插件、真实技能发现、guest/session、原生主任务请求、开启阻止/关闭放行、取消和撤权；协议模型夹具用于可复现实验，不代表真实 Autobiz 业务验收。
