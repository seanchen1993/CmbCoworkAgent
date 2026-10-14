# Skill 组合后端独立验证

实现范围：宿主 Skill catalog、选择 policy、显式技能准备与 Goal 引用验证、LocalSandbox 结构化读取及 cwd 检查。runtime、共享类型和 IPC 接线由主实施者负责，本文件不替代最终集成报告。

## 接口与生效链

- `listClawSkillSources()`：复用宿主来源、插件 owner、discovery 和全局禁用状态；仅导出 opaque ID、名称、摘要、可选 owner，不接受 renderer 路径。
- `createClawSkillPolicy(selection)`：缺省/all 不扫描并保留旧路径；selected 构造当前目录并拒绝来源丢失、禁用及摘要变化。`skillPaths` 是元数据注入的精确文档白名单；`lifecycleSources` 使用真实根和 `maxDepth: 0`；`middlewareSources` 是允许技能的父目录，必须同时配合 backend policy，不能单独使用父目录当授权。
- `LocalSandbox.setClawSkillPolicy()`：read/ls/glob/grep 都过滤，cwd 在 workspace 提前放行前检查。最具体注册根决定归属，选中子技能可遍历祖先，但不能读取排除的父 SKILL.md。目录 junction/别名按真实路径检查。
- `prepareStandardUserPrompt`：根据可信 thread/workspace 获取绑定，在 UserPromptExpansion 前拒绝未选择技能；异步 expansion 后、Skill lifecycle 前再校验。
- `validateExplicitSkillReference(input, scope?)`：带 scope 的 Goal 等入口做相同选择检查；未传 scope 保留历史调用签名，由入口负责正确传入。
- 实际读取使用 canonical 路径匹配生命周期；PreSkillUse 后及读取内容后再次核验，避免 Hook 异步期间发生修改还交付新内容。

## 真实文件验证

`output/mods-skill-backend-tests.log`：4 文件 25 项通过，含：

1. 旧/all 无目录扫描；相同名称来源具有不同 ID；renderer 目录无本机路径。
2. 嵌套父子、选中子但未选父、选中父但未选子、新增嵌套 SKILL.md 不自动授权。
3. selected 空、普通工作区文件不受影响、junction 别名、全局禁用、来源移除、文档变化。
4. 真 LocalSandbox read、supporting file、ls、glob、ripgrep 输出过滤；工作区内部技能 cwd 拒绝。
5. 选中 alias 实际触发生命周期；PreSkillUse 修改 SKILL.md 后不泄露修改后的内容。
6. 显式消息和带 scope Goal 引用在 expansion/activation 前拒绝；允许项按既有路径完成；异步 expansion 修改后拒绝。

本轮发现并修复了两处实施缺陷：真实 alias 读取可能遗漏生命周期；大目录的新根检查把 realpath 放进线性查找谓词，造成大量重复 IO。均有真实文件回归覆盖，不能仅用静态源码断言代替。

## 512 条来源测量

本机 Windows、512 个小型真实 Skill 文件夹、全选，未使用线上模型。单次 catalog **404.50ms**，构造 policy **660.26ms**；连续 5 次各过滤 512 个 supporting file，耗时 **757.70–798.95ms**，p50 **792.07ms**。完整样本记录在测试日志 `CLAW_SKILL_512_PERFORMANCE`。

过滤核对真实路径、SKILL.md 摘要及当前禁用/来源状态，约 1.55ms/文件；这是工具枚举时的开销，不发生在每个 token。样本和机器有限，没有可比较的旧版同语义实现，不能将结果表述为整体性能提升。大量目录时可进一步优化一次操作内的重复核验，但不能跨异步 Hook 缓存授权判断。

新模块及本轮测试 ESLint 通过，日志 `output/mods-skill-focused-lint.log`。旧 `plugin-skill-sources.spec.ts`、`skill-sources-priority.spec.ts`、`skill-lifecycle.spec.ts` 三个独立脚本均退出 0，记录在 `output/mods-skill-legacy-results.json`。后者继续覆盖历史禁用技能的 read/ls/glob/grep 行为。

## 边界与剩余集成验收

Skill 选择限制宿主技能入口，并非 OS 文件沙箱；普通 shell 从其他 cwd 读绝对路径、用户粘贴文本，以及其他插件已有文件权限不由此撤销。摘要固定 SKILL.md 和身份，不固定所有 supporting files 内容。

runtime context snapshot 必须使用精确 `skillPaths`，不能只传父目录；普通子代理需继承宿主选择，可信 Flow 子线程需沿用现有 scope/incarnation 校验。此类接线、真实模型/Electron E2E、MCP 和 UI 的最终结果需以主实施报告为准。本文件不宣称整个迭代已完成。

## 冷启动 SDK / 原生 Flow 追加复核

仅修普通 runtime 不足以覆盖独立 Function command。追加核查发现 `command-backend.ts` 和 `flows/native-host.ts` 单独创建的 LocalSandbox 也必须传入 Skill policy；否则 `$.tool.call` 的原生 `read_file` 可能绕过选择。现已补齐 policy、精确 lifecycle registry，以及 selected 模式的 HookScope/scoped hook resolver。来源失效时先拒绝，之后才注册原生适配器。

`v2/tool-permission-host.ts` 的冷 native permission probe 由另一实施者补入同一 policy/registry，真实 `LocalSandbox.createPermissionProbe` 验证未选路径 deny、已选路径 allow。探针不启动工具或 MCP 连接。

追加测试 `output/mods-skill-command-backend-tests.log` 共 4 文件 **35 项通过**：新的 standalone command 测试走真实 LocalSandbox 与实际 `attachModBackend` 注册的 `invokeTool`，覆盖两会话选择、selected 空、旧未绑定路径、来源更新前置拒绝以及选中技能 owner 激活；Flow root 检查实际配置的 policy/registry；冷 permission probe 保持同选择。相关文件 ESLint 通过，见 `output/mods-skill-command-backend-lint.log`。

这仍不限制 `$.fs` 的通用文件访问权限，也不把一个原生 `read_file` 生命周期误称为完成整个 Agent turn 的 PostSkillUse/Stop。线上或真实 Electron SDK 全链结果另由主实施者集成回归。

## 最终构建的存量回归

在主实施者确认最终 typecheck/build 完成后，按顺序运行三个已有 Electron 脚本，全部退出 0：组合能力 **11 组**、业务 Flow **9 组**、传统 Plugin/Harness **7 组**。实际用时分别 24.35s、56.86s、13.39s。结果见 `output/mods-skill-mcp-regression-e2e-results.json`，日志为 `output/mods-skill-mcp-regression-*.log`。本轮未重建这些测试使用的最终 out，也未修改生产代码以适配测试。

`npm test` 后半部分九组独立命令逐组运行：adoption、messages、hooks、plugins、task-cards、merge、desktop-agent-baseline、im-v1 共 **8 组通过**；workflow 的前置测试及 script 32、engine 96、worktree 66 均通过，随后仍在旧 `pwd -W` 的 PowerShell 参数歧义失败。保留该组退出 1，未修改无关基线。原始汇总 `output/mods-skill-mcp-standalone-results.json`。

为避免 `&&` 使后续覆盖遗漏，另外执行剩余 25 个 workflow 脚本：24 个首轮通过；消息队列源码断言仍匹配旧的 `const selectedModel = queuedModel?.available`，与已实现的 Claw 默认模型优先行为不符。只更新该断言，要求绑定 Claw 时仅使用其有效模型、无绑定时保持 saved→current 的既有回退，复验 **52 项通过**且 lint 通过。原始失败保留在 `output/mods-skill-mcp-workflow-resume-results.json`，后续通过证据为 `output/mods-skill-mcp-queue-plumbing-recheck.log`。因此剩余 25 脚本完成覆盖，但仍不能声称原样 workflow 或 `npm test` 全绿。
