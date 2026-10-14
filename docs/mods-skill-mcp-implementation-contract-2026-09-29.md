# Claw Skill / MCP 组合实施契约

日期：2026-09-29。开发分支：`codex/mods-v2`。

本轮交付目标：一个会话组合 Function 插件、模型、已安装 Skill、已配置 MCP 服务，保存后应用到对话，普通聊天和可信 Flow 子任务使用同一副本。不是任意内核组件替换，也不声称 Claude 官方拥有相同的可视化界面。

## 数据和兼容

- `ClawProfile.skills`、`ClawProfile.mcp` 为独立可选选择，结构为 `{ mode: "all" | "selected", items: { id, name, digest }[] }`。
- 缺省/all 沿用当前全局已启用来源；selected 空数组明确关闭本类宿主能力。全选仅是当前目录的快照。
- Skill 选择粒度为宿主注册技能；MCP 本轮粒度为服务/provider，不是服务内单个工具。UI 明示粒度，不把工具清单过滤冒充服务沙箱。
- Skill ID 由宿主来源和路径生成，digest 固定 SKILL.md 与身份；MCP ID 为 providerKey，digest 固定宿主配置身份，不持久化连接 generation。摘要不可替代完整 supporting files 或远端实现快照。
- 单类最多 512 条，ID/名称有界且唯一，摘要 SHA256。解析重建白名单字段，不接收 renderer 路径、凭据或完整配置。
- 保存/应用验证当前来源可用性及摘要；运行和实际激活/调用重新核对，不自动替换失效同名来源。
- 未绑定、旧 profile、Mods 关闭和既有 Plugin/Harness 保留原路径。全局禁用/权限与 Claw 取交集，不能重新授权来源。

## 目录与运行链路

- 新增独立 `clawSources(threadId)` IPC，仅打开编辑页时读取；clawView 不额外扫描目录或连接 MCP。
- 目录类型 `{ skills: ClawSourceEntry[], mcp: ClawSourceEntry[] }`，entry 为 `{ id, name, digest, owner?, description? }`。只返回当前可用来源；UI 合并已保存失效项并标注，不能静默丢弃。
- MCP 目录只读配置，不能连接服务。运行期包裹既有 service，list/get/peek/snapshot/invoke/configuredServerNames 一致按 provider 筛选，所有 alias/raw fallback/transport fallback/辅助调用都经过包装器。未选服务不会获得工具调用；既有共享 MCP 初始化仍可能连接全局已启用服务，必须在报告说明，不能宣称进程/连接隔离。selected 空可直接返回空，不初始化全局 service。
- Skill catalog 复用既有 discovery/disabled/owner 机制。runtime middleware、生命周期 registry、显式激活前检查、结构化文件读取使用相同选择。按最具体注册根处理嵌套技能，允许遍历选中后代的祖先，但不能读取被排除父技能 SKILL.md。真实路径别名不得绕过；workspace 内 cwd 同样检查。
- Skill 组合限制宿主技能入口，不是 OS 文件沙箱，不禁止通用 shell 读绝对路径或用户自行粘贴技能文本。
- 普通子代理继承父 runtime 的受限服务/backend；可信 Flow 子线程复用已有 root/incarnation 校验。不扩展任意 parentThreadId 信任。

## 交互

- 编辑器增加两组独立来源选择：“技能 Skill”“外部工具 MCP 服务”，每组“沿用已启用来源 / 仅使用所选”，支持搜索、计数、全选当前、清空、失效项移除。
- 初次打开优先载入当前绑定组合；后台刷新不覆盖正在编辑的 draft。保存、应用、执行保持分离，并解释实际生效位置。
- 侧栏展示两组摘要；技能显式发送即使 UI 缓存残留也必须由宿主拒绝。尽量过滤当前对话斜杠菜单，失败不得错误显示为全部可用。

## 验证门槛

两位 agent 方案通过后实现；完工独立检视。新增解析/持久化/IPC/运行链路测试，真实 Skill fixture 与真实 MCP server 验证实际允许/拒绝。覆盖空选、继承、来源变化、两会话、可信子任务、别名/fallback、SDK、显式 Skill、禁用与 Mods off。回归旧 Plugin/Harness 与 composition/Flow Electron E2E，截图新增 UI，记录目录耗时及调用初始化次数。最终报告区分新增失败和基线失败，未通过不得宣称完成。

## 对齐证据

官方公开 Mods README 描述插件注册 hooks 与 engine interface；公开 d.ts 当前标注 2.1.277。本工程已有反编译参考基线为 2.1.283。本轮不将来源选择 UI 宣称为官方界面复刻，也不将本轮完成等同全面兼容。

- https://raw.githubusercontent.com/anthropics/claude-code/main/mods/README.md
- https://raw.githubusercontent.com/anthropics/claude-code/main/mods/types/claude-code.d.ts
