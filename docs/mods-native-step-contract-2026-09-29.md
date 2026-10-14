# Skill / MCP 原生流程步骤实施契约

本轮在 `codex/mods-v2` 扩展已有 Flow，不改变普通对话或传统 Plugin 默认行为。
目标是让用户直接组合“选定 Skill + 模型执行任务 → MCP 工具 → 插件动作 → 检查”。
这是本工程的可视化编排能力，不宣称 Claude 官方有相同页面或编排协议。

## 数据与运行契约

- `skill` 保存宿主目录来源 `{id,name,digest}`、任务、可选 Agent/模型/模型角色；不接收文件路径。
  宿主解析路径，检查当前 Claw 范围与内容摘要，通过既有可信显式技能激活、Hook 生命周期运行。
  阻断时不能调用模型；每次模型请求与发布结果前检查来源仍有效。
- `mcp-tool` 保存来源引用、精确 toolName、规范化输入/输出 schema 摘要、对象输入、可选前序输出指针。
  不保存连接凭据、transport config 或 renderer 提交的 schema；connectionGeneration 只在本次运行冻结。
  宿主重新发现并检查 schema/config/范围，走现有权限、审计、内容保护与 scoped MCP 调用链。
- MCP 目录独立显式加载。编辑页、侧栏普通刷新不打开连接；按钮说明加载会连接已启用服务。
  加载前后检查线程 incarnation、项目、Claw 绑定；迟到结果不得进入新上下文。
- MCP 禁止业务自动重试，也禁止后续节点回退跨过 MCP 节点。schema 拒绝此类回边，运行时每个
  run/step 最多一次实际调用。异常、超时、取消、输出校验失败和重启不重放；不保证远端事务回滚。
- 前序输入支持 plugin-action / mcp-tool 的已通过且未失效输出。输入和输出保持现有 JSON 大小限制。
  MCP 输出统一对象封装，保留 text / structuredContent；远端 isError 记业务失败并停止。
- 保留已有所属 Function Mod 的授权及强制完成规则。Skill 指令不是独立可执行函数；仍需模型。
- 旧定义可原样读取；新增节点、计划和历史字段可选扩展，不迁移或覆盖旧配置。

## 验收

两位 agent 评审通过后实现；独立检视后冻结代码再跑广泛测试。
覆盖合法/伪造/过期来源、同名工具与 Skill、selected 空集、撤权/变更/重连、取消、拒绝、
回退防重复、真实 MCP stdio 计数、Skill PreHook 阻断模型、保存重载、输出接后续动作，及新旧 UI。
运行 typecheck/build、针对测试、Mods 回归和完整 Vitest；对比已记录平台基线。
真实 Electron E2E 使用隔离用户数据和受控模型，保存截图及机器可读报告；另外回检传统 Plugin/Harness。
