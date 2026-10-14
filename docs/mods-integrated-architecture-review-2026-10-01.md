# 四方向统一迭代：架构评审与底层验收

工作区：`C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
本记录属于整体迭代的一个领域，不替代最终 Electron、全量和性能验收。

## 方案评审

已审阅 [统一契约](mods-integrated-iteration-contract-2026-10-01.md)。必要修改纳入后通过：

1. 附加 report 和 check 均不能借项目 repair 将新增检查升级成自动写入；有附加规则时
   合并结果收紧到 check、maxRepairs=0，UI必须说明。无附加规则维持原项目行为。
2. 子运行仅处理自己的 PostSkillUse；将已激活插件、Skill scope 汇总到父运行，父 Stop
   一次。Stop要求修订、继续或阻断时不能发布成功；不隐式模型重试。
3. Mods 最终 gate/checkOnly/阶段提交不能重复。旧 Stop 脚本本身的外部副作用不构成事务，
   先执行旧 Stop，再捕获最终检查证据，不能宣传跨任意脚本回滚或强幂等。
4. off/default 不因默认 project scope 与附加 diff scope 产生冲突；活动项目规则范围不同
   则明确拒绝。合并检查项并集、预算取小值，阶段权力只来自原应用设置。

## 已实现的底层路径

- 合法本地 normal 项目与 Feature 会话进入 host v2 Flow；结构失效、扁平伪绑定、相互冲突
  的 project/feature 身份拒绝。`harnessFeature.runId/nodeId` 属于受控制器管理的会话，
  此次仍拒绝。远端、IM、workflow、coordinator 和调度保持限制。
- 主进程从父线程 DB 读取绑定，复用原 `getHarnessAgentContext` 和标准 runtime factory。
  子 runtime、父原生 sandbox 保留真实项目 Hook 上下文；只读角色不被 Harness 合并放宽。
  标题修改不会撤权；绑定、已启用插件或上下文改变会失效。纯项目会话单独验证 adapter
  存在与稳定，不虚构 Feature。阶段名称改变拒绝，状态进展可继续。
- 昂贵 Harness 上下文读取放在已绑定 Flow 的操作边界；普通会话不额外调用 worker。
  250 ms watchdog 仅检查稳定 DB 绑定和插件清单，不反复重建项目上下文。
- Agent 与 Skill 子步骤均使用标准 prompt 生命周期，并保留父取消、租约、权限和清理。
  父 Stop 失败状态被记住，第二次 finalize 不能越过失败或重跑 Stop 副作用。
- Claw 附加规则经过浏览器安全解析与主进程二次校验，只能引用完整选择且版本固定的能力。
  有效策略进入现有单次 completion gate，Flow/完成证据指纹包含附加规则；未配置规则时
  保持原指纹对象结构。不存在第二个独立的附加规则 stage commit。
- 原生检查结果由宿主写入 `FlowStepResult.check`。普通结束文案说明查看实际步骤记录，
  不再无条件声称全部检查通过。

## 已运行验证

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| 原生 Flow + 规则 gate | 2 文件、71 项通过 | `output/mods-integrated-arch-gate-tests.log` |
| shared rules、Harness、Skill、Flow IPC、Claw 与组件/项目规则存量 | 9 文件、129 项通过 | `output/mods-integrated-arch-regression.log` |
| 最终父 sandbox 上下文、原生 Flow、规则 gate、真实 Autobiz 完成链 | 4 文件、101 项通过，含真实 Autobiz 26 项 | `output/mods-integrated-arch-final-tests.log` |

以上范围有重叠，不相加。此前发现过的四项 completion 失效回归保持原断言通过。
该领域 ESLint 0 错误；累计测试文件仍有格式警告，未整体重排旧文件。统一最终类型检查
由主任务在所有领域冻结后重跑，不能把中途其他领域未接完接口的结果写成最终通过。

实际 Electron 旅程、同负载性能、全量 Vitest 和九条独立链以整体交付报告为准。

## 交叉检视与独立补充验证

- Autobiz 汇报输入：只接宿主当前 run 的前序有效尝试，失效、跳过、未来步骤不进入汇报。
  原生测试必须同时满足定义 check、native-check 来源、受信 check 字段与真实 evidenceIds；
  伪来源和旧无受信字段记录不冒充原生测试。状态互相矛盾拒绝，24KB 超限拒绝而非截断失败。
  此处代码复核通过，真实 action envelope 回归由 Autobiz 领域记录。
- 模型取消：审阅独立 cancelId、frame 结束、runtime-client 到 provider 的 AbortSignal 转发，
  以及 reservation finally 清理。补充真实 HTTP SSE 与真实 QuickJS 会话关闭测试，
  `output/mods-integrated-model-cancel-http.log` 2 文件 6 项通过。取消即使被插件捕获，
  completion 预算仍因未知 usage 拒绝通过。SDK 返回的零用量占位不代表账本把未知成本算作免费。
- 模型真实 Electron 测试已补到 `tests/support/mods-model-http-284-e2e.ts`：预取消零请求、
  一次独立取消不影响并行 sibling、父 job 取消关闭全部 HTTP、会话后续仍可用。
  此处只完成代码与 lint，实际运行结果必须等待最终 build 后的 E2E，不在此提前写通过。
- 技能与工具展示：复核全正文快照、取消与权限检查、源文件变化拒绝、分页共享一次展开，
  以及 dispatcher 每层 pinned-input 对 skill/tool/provider 的保护；中间 next 改名不能穿越身份边界。
  工具说明只调整描述，不扩权限。新增伪身份反例已独立重跑：presentation-events、真实
  LocalSandbox 技能分页、prompt-snapshot、evidence-input 共 4 文件 28 项通过，日志
  `output/mods-integrated-cross-review-tests.log`。LocalSandbox mock 缺 classicEvent 的诊断
  警告不影响断言，不能据此证明真实 legacy Hook 集成已验收。
- Skill 标准消费路径仍由模型 read_file 读取完整技能正文时触发展开；显式 Skill 与 Flow Skill
  共用此宿主路径，无读取不声称正文已激活。这和 Claude Skill tool 主动展开的入口形式有差异。
- 新版原版核验见 [286 审计](mods-claude-2.1.286-audit-2026-10-01.md)。原版 10 项探针通过，
  新增 prompt.compose、prompt.submit asUser 不在四方向实现范围；目录把前者明确标为 unavailable。

本轮未消除的限制包括：控制器/远端/IM/workflow 不开放为普通 Flow，任意旧 Stop 外部副作用
不提供事务回滚，ToolSearch 放置不模拟，以及 286 新增完整 system prompt compose 未接入。
这些边界不能借成功的局部测试推导为整体完全兼容。

## 实际入口追加复核

最终检视发现后端支持不等于用户能进入：ChatContainer 的 Flow enabled 与 ClawSidebar
仍用旧项目模式总开关拦截，App 的 Harness 分支没有 Claw portal，且把 claw 选择降回 work。
已移除两处过宽限制，继续由严格 `isOrdinaryFlowMetadata`、Mods 开关、readOnly 与主进程
catalog 共同检查；Harness 分支新增常驻 hidden/inert sidebar host，绑定渲染中的会话 ID。
生产 guard 表达式与提交锁回归 16 项通过，日志 `output/mods-integrated-harness-entry-tests.log`。

`tests/legacy-plugin-project-e2e.spec.ts` 已扩展真实项目/Feature Claw 绑定、Flow 启动、
人工确认等待与取消，并新增从项目模式页面打开 Feature Claw 工作台、在输入框发送的旅程。
等待统一构建后串行执行，暂未记录通过。

Autobiz 真实 repair E2E 暴露审批等待被取消的问题，当前仍在追查。补充修复只保证正确诊断：
FlowManager 记录父 signal 的真实原因，子运行清理导致审批取消时不再伪造用户主动拒绝，
真正用户拒绝仍立即停止 Flow。31 项 Flow 调度回归和 6 项拒绝/取消边界测试已通过；
不能把这两项修复写成真实修复旅程已经完成，必须重跑原失败场景。

静态追踪进一步确认：现场审批请求从发送到撤销约 7 毫秒，约 7 秒是整个 repair 初始化与
执行时间，不是审批超时。prompt composer detach 只关闭草稿 broker，Skill turn 与标准
runtime factory 未提前结束 stream。原日志没有记录 subagent catch 的首个异常，无法据此
判定是父 scope 撤销还是子 stream 先抛错。已在子流清理前、Flow watchdog/host revoke、
审批同步分发三处加入受限诊断，异常仍原样抛出；不记录工具参数、正文或完整异常对象，
只保留经脱敏和限长的错误元信息。诊断 helper 3 项测试通过，修改区 lint 无错误。
最终归因仍以重新构建后的原场景结果为准。
