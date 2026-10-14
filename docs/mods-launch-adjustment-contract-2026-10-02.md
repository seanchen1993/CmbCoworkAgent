# 官方 Mods 发布后的调整契约

本轮只在 `C:\ai\CmbCoworkAgent-mods-v2` / `codex/mods-v2` 实施。
以官方 2.1.287 的完整 Windows 包、内嵌声明和原版插件探针为依据，
继续完成四方向集成交付，不修改 UAT，不将反编译源代码复制进产品。

## 调整结论

保留已实现的 Claw/Flow、隔离运行时、授权、完成证据和旧 Plugin/Harness 适配。
官方 Mods 是 Plugin 内的函数模块和可包裹/替换的 Hook，不要求用户先设计流程图。
本工程还需要把系统提示词组合接到真正模型请求，并证明可信内置模组实际可被组合。
不能把事件名称已登记、可上传插件或 Flow 的可编排性当作这些能力已经完成。

## 提示词组合

- 新增 `prompt.section` / `prompt.compose` 事件与 `$.prompt.compose()` SDK，直接返回 `{text}` /
  `{sections}`，不套操作 `{value}`。section 支持 null 删除；compose 支持增、删、改、重排。
  独立 `$.prompt.section()` 不是官方插件 SDK，本工程只提供 section Hook。
- 在真实 provider 请求处执行：宿主解析实际模型和工具 → tool.describe → section / compose
  → 对最终输入重新核验预算 → provider.stream。用户消息、工具 schema、身份和供应商凭据
  保持宿主所有。不在早期 middleware 改一段之后又被后续 middleware 重新追加。
- 系统消息按实际消息边界生成稳定 `cmb:system:<index>` section，保留最终原始内容来源；
  不靠正则猜测 memory、output-style 或项目指令的边界。首轮不承诺能单独删除其中每种来源。
  无 Hook 变更时保留原消息对象及内容。非文本系统 block 不静默丢弃，明确拒绝文本组合替换。
- 字段对齐 287：model 固定；promptModel、surfaces、tools、outputStyle、traits 结构校验。
  SDK 省略字段读取当前宿主绑定的实际请求。改变 facts 只影响本轮 Hook 组合输入，不改变实际
  模型、工具权限或 credentials；本工程不伪造 Claude 的 SDK/teammate/bare 分支。
- SDK compose 基于真实请求快照，不发模型请求、不自动发消息、不写草稿。无绑定或租约过期
  明确拒绝。同一 compose frame 自跳过，其他同插件 Hook 继续执行，不整插件排除。
- section id 非空且唯一，shared 必须在 session 前，text/scope/数量/总字节均有上限。
  无效 Hook 结果跳过当前 Hook，下游最多 fallback 一次；已经调用 next 时保留其合法结果。
  取消、撤权、宿主权限/生命周期错误仍必须失败，不能回退旧原文。
- guest 可见数据执行现有内容保护，返回后再保护并复验；真实权限和运行绑定不由提示词决定。
  不将普通 AGENTS/CLAUDE/项目规则自动称为企业 managed，不宣称拥有 Claude sec-default。
- 最终提示词预览记录实际发送的组合结果。shared/session 在本工程只表示排序和语义，
  不承诺所有供应商具备 Claude 的跨组织 prompt-cache 边界。

## 用户顺序和可信内置模组

- 应用 Claw 后按已校验 capabilities 数组的保存顺序执行用户插件；未选择 Claw 的旧路径
  保留原 id 顺序。顺序变化进入保存版本、应用预览和失效判断，不使用未经授权的来源。
- 新增内部固定 context-meter 模组，tier builtin，在 user Hook 后；实际 AbovePrompt 上
  显示同线程宿主提供的当前上下文占用。没有真实 window/usage 时让出或显示无数据。
- 开关是 `ClawProfile.builtins.contextMeter` 的保存/应用快照，默认关闭；零上传插件也能启动。
  用户 Hook 可直接返回接管 UI，也可 next 包装。外部 manifest 不能自行授予 builtin tier。
- 关闭、重载、换组合必须清除旧绘制和 VM。该模组证明 trusted builtin 基础机制，
  不宣称既有 output-style、diff、memory、所有内核功能都已经可替换。

## 评审与验收

两个 agent 分别检查官方文档/代码架构与原版二进制/探针契约。以上精确范围获得条件批准；
实现后的代码和真实测试关闭各条件后才能最终通过。保留第一次失败日志，不抬高原回归预算
来伪装全量通过。定向测试覆盖非法返回、取消/撤权、frame 递归、真实 provider 入参、最终预算、
预览、无 Hook 保真、零插件 builtin、user 覆盖、顺序与旧默认路径。再执行 Electron、浏览器、
性能、类型、lint、构建及旧 Plugin/Harness 回检。最终还原普通构建，测试入口不得进入产品包。

## Flow 子 Agent 验收发现后的修订（2026-10-03）

新增真实 HTTP marker 验收发现独立 Flow child runtime 仍受旧 main-only provider gate 限制。
两位独立评审同意本次修复方向，实施须同时满足以下约束：

- 独立 child runtime 使用自身真实 authority、模型、工具与预算，不将 child 改称 main。
- 共用现有受保护模型 stream scope；宿主为 child 禁用 turn.step guest Hook，但保留
  Function session/grant/epoch/publication 和 lifecycle signal，撤权立即中止 HTTP。
- 实际流拉取建立 fresh child FunctionExecution；仅建立 generator 不算完成接线。
  取消后的 cleanup 仍应关闭原 provider，不借用父 owner 或重新授予失效 authority。
- child 不回写 main session 模型或 main 提示词预览。SDK compose 用真实 authority 对象
  隔离最新快照，composing ALS 也校验 owner；入口、返回及短路结果均核验 authority 和
  原请求/caller 合并信号。无当前真实 owner 或绑定则明确 unavailable。
- 保留跨插件 Flow HTTP marker 断言，补 owner 并行/过期、无子 turn.step、最终预算及
  撤权取消的回归。sources、Claw 继承和临时完成规则 owner 不变。

本修复范围为独立 createAgentRuntime 的 Flow child；同 thread 的 task/general-purpose
共享子 Agent 默认模型、独立 complete/classify/fork 不据此扩大为完整 compose 接线。

### 主会话真实拉取 scope 的追加收口

展示复测保留原断言，发现 main provider pull 同样不能假定存在外层 FunctionExecution：
section 生效但 SDK compose 没有 owner，新增 policy 缺席真实请求，日志也丢失。统一
真实 main/child 初始化、next、return、throw 和 asyncDispose 的 fresh authority scope，
main 仍 dispatchHooks=true，child=false；从宿主已验证 authority 取字段，用户动作标记
始终 false。模型 transport 专用入口清除祖先 calls/modCallContext/writeLease，并捕获
自己的真实物理租约，不改变其他 task/FS 入口或原写入保护。正常关闭用自身 owner，
失效关闭保留禁止 SDK 的 closed tombstone，仅关闭原 iterator。测试覆盖无外层 scope、
异 Agent 外层 scope、父文件写租约和返回清理。展示实际复测已恢复 compose policy、
原 Skill body 日志及全部六项断言；最终构建与统一回归在交付报告单独记录。
