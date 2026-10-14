# 原生 Flow Skill 节点后端检视与验证

范围：`codex/mods-v2`，2026-09-29。本报告只说明 Skill 后端与共用工作流生命周期；
整轮 MCP、页面和真实 Electron 验收由主验证报告汇总。

## 实现

- Flow 保存 `{id,name,digest}`，宿主目录解析真实路径。名称相同但来源不同的技能不会混淆。
- 每次 Flow 准备共用一个目录解析器，不跨运行缓存；即使 Claw 选择为全部，显式节点仍固定来源摘要。
  执行时检查当前选择、来源是否启用、路径真实身份与 SKILL.md 摘要。
- 子线程走 `prepareStandardUserPrompt(trustedExplicitSkill)`，共用 Hook scope、去重键与
  Skill tracker，随后交给真实 Agent runtime。结构化输出补正不会再次触发显式激活。
- 在模型调用前后复验来源。完成 Hook 在结果发表及线程销毁之前执行；阻断/停止导致该节点失败，
  不隐式重做业务。成功终态 Trace 在完成 Hook 通过之后写入。
- 修复共用可信技能入口的一个缺口：原始任务或 Hook 改写携带另一个技能尾标记时，模型输入仍以
  宿主已解析的技能标记为准。普通非可信显式选择路径保持原行为。
- 将取消信号传递到展开、前置、提交与完成 Hook 上下文；取消后不得继续调用模型或发表成功。

## 独立代码检视

另一位 agent 已检视来源解析、生命周期与模型前后校验，没有遗留阻断项。
采纳其建议，将完成 Hook 放到成功终态 Trace 之前。主 agent 负责 native-host 接线，
本实现者另外只读复核共享状态、真实 runtime stream 绑定和调用前后校验。

## 验证记录

| 验证 | 结果 | 本地日志 |
| --- | --- | --- |
| Skill、LocalSandbox、标准消息、完成生命周期回归 | 11 文件、77 项通过 | `output/mods-native-skill-regression.log` |
| 最后批量解析与工作流复验 | 2 文件、19 项通过；包含新加的第 12 项目录测试 | `output/mods-native-skill-final-recheck.log` |
| 节点 helper 与标准消息回归 | 4 文件、28 项通过 | `output/mods-native-skill-lifecycle-tests.log` |
| Node TypeScript | 通过 | `output/mods-native-skill-node-types.log` |
| 8 个 Skill 相关实现/测试文件 ESLint | 0 错误、0 警告 | `output/mods-native-skill-final-lint.log` |
| 独立轻量性能及过期 pin 拒绝 | 通过 | `output/mods-native-skill-performance.log` |

上述测试有重叠，不相加作为独立测试总数。最后批量解析新增一项，因此这些 Skill 回归文件
联合覆盖 78 项；这里不冒称有一份单次 78 项的日志。整轮冻结后的全套检查另由主验证统一执行。

## 性能

独立脚本 `tests/mods-claw-sources-performance.spec.ts` 使用本机 512 个真实小文档，无网络或模型：

- 无选择/全部模式两次调用约 0.22 ms，目录扫描 0 次。
- 512 项目录约 436.02 ms；完整选择 policy 创建约 647.19 ms。
- 一个流程中 64 个节点选同一来源：准备约 519.08 ms，整个流程目录扫描 **1 次**。
- 64 个节点摘要复验五次中位数约 40.15 ms，复验不重新发现目录。
- 512 项完整 policy 的模型边界校验中位数约 288.04 ms。
- 修改文档后，已解析节点及同一个解析器的再次解析均拒绝旧摘要。

这是受控小文件测量，不代表大文档、网络盘或所有机器。主宿主已将 250 ms 定时存活检查与
全文摘要校验分离；完整校验保留在 fingerprint、步骤执行、结果发表及模型前后等可信操作边界，
避免空闲等待持续同步读取所有文档。没有引入可能掩盖变更的长期摘要缓存。

## 能力边界

- Skill 是模型执行的技能说明，不是确定性函数。激活会给模型提供宿主可信路径标记，
  通过现有 read_file 与技能文件访问策略读取；不直接拼接全文冒充一次真实技能运行。
- 前置激活成功不等于模型已经阅读文档、更不证明逐条正确完成指令。真实 E2E 应观测
  read_file 和后续行为，而不能只检查提示词包含技能名称。
- 摘要固定 SKILL.md、来源与真实路径身份，不是整个支持文件目录的内容快照。
- 完成 Hook 对成功返回路径执行；异常或取消不保证执行 PostSkillUse。沿用现有完成 Hook
  runner 的异常处理语义，并未宣称任意 Hook 运行器内部异常都会转成业务拒绝。
- 定时检查不持续重读全文；在下一可信操作边界拒绝已变更来源，不宣称毫秒级实时撤销。

## 真实 Electron 暴露问题后的修复

原生 Skill E2E 最初在进入节点后失败，错误为 `MODS_THREAD_CONTEXT_REQUIRED`；旧 Agent Flow
同场景通过。检查发现准备/完成 Hook 在 `runtime.stream` 之外执行，未进入该子运行实例的
Function 异步上下文。物理后端绑定在 `childThread:workflowAgentId`，无上下文时查询退回 `main`，
从而命中“不允许将内部子线程作为冷启动普通会话”的既有拒绝。

修复没有放宽权限：runtime 成功创建后，向宿主交付一个捕获真实 authority 的生命周期回调。
原生 Skill 的 prepare/complete 经此回调进入准确的 thread/turn/agent 上下文；回调保持
`userInitiated:false`，不新增写权限。authority 失效、取消或被相同 ID 的新实例替换时，旧回调
拒绝执行；完成后再次检查，拒绝迟到成功。四种 Hook 上下文另外显式携带真实 agentId 供审计。

新增真实 `ModsManager` 回归复现未包装的错误，再验证 prepare/complete 都命中原 non-main
binding，以及撤权和实例替换不能重新获得权限。修复后 4 文件 43 项通过，Node 类型检查通过，
本次 8 个相关文件 ESLint 无错误/警告。日志：
`output/mods-native-skill-context-recheck.log`、`output/mods-native-skill-context-types.log`、
`output/mods-native-skill-context-lint.log`。真实 Electron 复验由主 agent 重建后执行，
该单元回归通过不替代最终 E2E 结论。
