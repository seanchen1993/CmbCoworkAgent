# Mods 连续定制与 DevClaw 使用迁移：本轮实现契约

> 2026 年 10 月 7 日说明：本文保留 10 月 3 日阶段的设计约束和验证记录，未改写历史正文。
> 其中纯文字入口及附件未接入的描述不是当前全部范围。当前操作见
> [DIY Claw 上手](mods-diy-claw-quickstart.md)，最新能力与待验收事项见
> [当前能力与后续工作](mods-official-features-and-roadmap-plain-2026-10-03.md)。当前目标是提供对应的实用能力，保留权限与清理边界，不要求复制官方全部内部实现。

开发工作区：`C:\ai\CmbCoworkAgent-mods-v2`，`codex/mods-v2`。UAT 不写入，保留现有全部未提交改动。官方参考固定为 2.1.288，原包及声明沿用已有校验产物；npm latest 已再次核对。

## 用户结果

官方模组保留“随着普通对话自动参与工作”的用法；在 DevClaw 中通过导入、批准、加入 Claw、确认应用启用，不要求每次发送 `/my-claw` 或把自动规则改成固定流程。需要固定顺序时才使用 DIY 流程。旧 Plugin 项目模式继续可用，选择组件与实际触发分开显示。

本轮优先完成下面四条相互配套的链路，并检查实际风格提醒的附件接点。保持具体边界，不宣称整个原版运行环境完全兼容。

## A：已知子助手的每次模型请求

- 让现有受支持的 GP/registry、独立 Flow/SDK 助手真实 `turn.step` 经过已批准组件；沿用私有 authority、创建时 epoch、实际 provider 对象对应配置及预算。
- `turnId/index/messageCount/agentId` 宿主固定，只接受已有 model/effort 选择范围。实际输入变换后重新核算预算。子请求不能调用 main activate、改主模型预览或会话事实。
- 现有流式 Hook 仅提供流转操作；本轮同步接入 FunctionSession 已有的 SDK 路由，权限列表、caller registration 与实际 SDK 调用均由宿主提供，不让插件注入 creator 或扩大批准范围。
- SDK 派出的助手跳过创建它的那个 Hook，若有准确宿主来源记录则只排除该 registration；不得以 guest 字段猜测，不得全跳过或仅按插件名排除。尚不能确定的创建来源必须继续标明范围，不能预记完整 parity。
- 来源从 FunctionSession 的 agent.spawn core 捕获 `{plugin: plugin.name, registration: source.registration}`，经 host-only 参数送到原生 child 启动回调，绑定实际 child authority 的私有 WeakMap；模型调用只读取这份记录交给流式分派器。无 creator 的原生 GP/registry/Flow 走全部已批准 Hook。不能从请求内容、toolCall.id 或插件自行提供的 spawnedBy 取得跳过权。
- 必须验证：同名不同端点、A→B→A、并行/嵌套、未知模型/超预算零请求、固定身份改写拒绝、关闭再开启不续权、流式取消清理、主会话状态不变。

## B：真实用户提交处理

- 生产入口必须在当前 run guard 下、可见用户消息提交之前，覆盖确定的普通用户入口和正在运行时的追加消息。由真正 Electron invoke/steer 宿主入口盖提交标记，不能仅凭 source=desktop 或请求中的一个 boolean 推断用户输入。
- 本轮只覆盖明确的普通纯文字 composer 入口。IM、command resume/managedAutoSend、所有 goal 控制/自动续跑、协调器/工作流内部通知、Flow-start、peer/plugin 提交不标作已覆盖。含文件/图片/技能选项等结构的输入保持原生产路径，不能拆字符串制造附件或技能身份，迁移报告和文档说明该边界。
- fresh 请求在真实 physical guard 成立后建立短生命 preflight owner/binding，pin runToken、lease、thread incarnation、工作区和原 config epoch，finally 释放；不借 ambient 旧 main。忙时追加绑定 exact 当前 owner、preparer token、队列所有者，不替换 main。
- 官方输入固定 origin/wait/turnId/附件事实，允许 text/context 下传。改写文字更新同一个可见用户消息；context 只送模型且不显示。已有图片/技能/目标宿主标记及原 Hook 规则保留，不以字符串猜新的授权。
- 以 core 实际接收为事实：只有 `next` 下传能进入。core 内完成一次真正的 transcript 提交/入队承诺，再返回已接收正文；不能等外层 Hook 返回后才提交。幂等 admission promise 保证重复 `next` 不重复持久化；调用 `next` 后返回另一份 text/context/drop 不能改掉或撤销已接收内容。
- 普通 invoke 的 accepted ack 使用原 userMessageId 同步替换乐观气泡，忙时 steer 的 accepted 回执也携带 visibleText；drop 不写入用户记录，移除对应乐观气泡并保留拒绝原因。隐藏 context 不写入可见气泡。
- 保留 legacy UserPromptSubmit/PreSkillUse、工作模式原事务、运行租约、IM 重试、取消和队列归属。若某一入口尚无法安全接入，只标为范围外，不在 catalog 宣称覆盖该入口。
- 必须验证：真实改写与存储、隐藏上下文、拒绝零模型调用、事后修改无效、重复 next、失败/取消、技能身份保留、富内容无损、旧模式与未启用路径。

## C：独立模型分析的自己的规则

- complete 使用自己的身份正文、显式 system 和一条用户输入；classify 使用真实分类正文；fork 使用明确宿主快照。不得自动混入 main AGENTS/memory/历史/工具。
- 在各自真实 provider 调用前构建独立 compose/section frame，model/tool/traits 如实提供。实际变换后的完整内容再次检查 provider 输入预算、原输出额度和内容保护。
- 各次 frame 使用宿主局部作用域，不能把 owner WeakMap 的“最新请求”当作同时进行的另一次请求，不能污染 main 的可重新组合快照。
- compose/section 内的辅助模型调用采用宿主防递归，明确拒绝独立 compose frame 内的重入（MODS_MODEL_COMPOSE_REENTRANT）；不会静默绕开批准、计费、取消或内容保护。普通 turn.step 内独立调用模型不被此规则误伤。若仅主 compose 内的第一次独立调用可成立，也必须让其自身 compose 内的第二次被拒绝。
- 保留 legacy string/null 与 result-v1 返回、usage/accounting、原有 tools/history 限制。
- 必须验证：三种请求实际正文、空默认 system、并行同 owner、实际 HTTP、变换后超预算拒绝、递归、撤权/关闭、快照释放、不修改主对话。

## D：符合 DevClaw 习惯的兼容说明

- 安装/授权处说明“自动在普通聊天参与”与“选择流程显式执行”的区别；右侧 Claw 工作台分别解释保存模板、应用当前对话、运行一次。
- 将已检查的事件映射为普通语言：触发时机、用户作用、已接入范围、未接入时影响和可用替代方式。原事件名放到可展开的作者细节。
- 当前检查仅 registration-events-only，不把 strictCompatible 宣称整包可运行。结果继续绑定 digest 和当前入口；SDK/import/未触发效果明确尚未验证。
- 旧 Plugin 没有 Mods 组件不是损坏，旧项目方式继续使用；要加入 Claw 时才声明可选择的能力。已选组件不等于本次已经执行。
- 必须验证：成功/部分/未支持/未知报告、版本变更后旧结果失效、普通聊天和流程入口、空组件/旧 Plugin、窄屏、键盘、原反馈与结果保持。

## 提醒与其他能力

输出风格的真实 Human/Tool 提醒是可检查的首个 `prompt.attachment` 候选，必须采用官方相应种类/宿主 origin，保留原消息属性与工具关联；未确认契约前不实现、不把 system section 当附件。完整初始 `prompt.context.instructionFiles` 需要真实文件与正文的一致性，不通过拆标题伪造；若本轮成本和风险超出核心链路，保持明确后续项。高级声音/终端/远端能力同样保持明确差距。

## 检视与验证

实现前两位独立 agent 审核本契约；按其意见修订后开始生产修改。各行为添加有意义的回归，先定向测试，再类型/定向 lint/正常构建。重型测试串行，实际 Electron/浏览器验证普通对话、受支持子助手、关闭/取消和迁移入口；复跑旧 Plugin/Harness、Autobiz、Flow。全仓失败与既有基线逐项比较，不删断言、不增加超时来换通过。性能检查针对重复处理和预算，不用网络快慢猜优化收益。所有完成状态以实际记录为准。

## 实现检视记录

方案实现前，official_mods_review 和 latest_mods_binary_review 两位独立评审通过 A–D 的契约。实现中继续按阻断意见修正，而不是仅凭静态通过计入完成：

- 冷初始化若只有空工具列表，会使原版 session.start 读取项目配置失败并永久丢失注册。本轮以 private actual-authority WeakMap 提供只读权限查询，真实 File SDK 仍保留原根目录、grant、稳定句柄、内容保护及 selected-skill policy/lifecycle。queryFunctionTool/invoke 不使用该查询上下文，临时 binding 没有执行器；结束即删除。
- 流式 guest host 的 AsyncResource.bind 捕获首次 pull 的 ALS，首帧返回后 scope 已关闭；只包原生 core.next 不足。两位评审确认 host-only transport 闭包后，将所有 streaming host RPC/SDK 在捕获的 actual authority、原 binding/epoch/lease 下重入并前后核验。保留全局 GuestRuntime 绑定、frame token、signal 和 scope 过期拒绝；native core create/next 明确 ownscope，expired return 只用 tombstone 清理。
- 真实 QuickJS main/child 两帧、yield 后 session.id/ui.log/model.complete 回归通过；release、disable-reenable、cancel 的暂停 SDK 阴性回归通过。disable-reenable 不额外 abort，通过旧 SDK 返回后的 guard 直接阻断后续日志和 provider continuation；expired finally 无 SDK authority。两位评审最终静态 PASS。
- 真实 Electron task-model-288、continuity、compatibility、agent-spawn、model-http-284 五组 29 checks 已通过。逐次 child 实际第三端点再回自身端点、同公开名称不混用、正文一次提交、拒绝、隐藏背景恢复、busy steer 和 independent frame 均以实际日志/HTTP/保存记录核对。
- 整体取消回检发现 shared child 使用私有 runtime ID，而旧 IPC 用公开 tool call ID，导致已交付 partial 没进入完成事实。两位评审通过最小修复：宿主固定 authority streamSource；在真实模型边界 callback 返回后重新检查 signal/绑定/创建 epoch，再通过 exact authority WeakMap 和原 observer 记录实际变换后的 chunk。旧 IPC 对这些 entry 一律忽略，即使公开标签猜中私有 ID 也不能写入，避免重复或串任务；完整 response 仍独立统计 usage。真实 manager/boundary 取消及生命周期冲突回归通过，3 文件 65 tests。重复 task 的 E2E 同步改为本次 invocation 桶和本轮 stall seed，不增加等待时间或放宽 partial 断言。
- 授权后再发送的整体回检发现 fresh preflight 替换 resident main 会使并发 UI 初始化失效，表现为消息未入账、没有 provider/completion 调用。两位评审通过独立 composer UUID 的 authority、binding 与 private fs query；显式 pin 创建 epoch，保留 main view、catalog、读取快照和正在进行的初始化，不重跑 session.start、不自动重试已发生副作用、不降低旧 scope guard。准备结束或取消只释放自身。4 文件 15 tests 验证 resident main/session read 在成功和取消前后仍有效，配置只读查询可用但工具执行仍拒绝。
- Claw 状态入口保留原生 button，使用 aria-live 公布状态；浏览器验证键盘可识别按钮、点击进入结果页和侧栏反复开关。旧 source-shape suites 改用明确函数边界，不靠固定字符切片；保留原 neutralization 和失效 guard 断言，并新增 Mods plumbing 拒绝检查。

- 关闭 Mods 的实际回检发现历史命令结果跟着 scope wrapper 卸载。两位评审通过组件自身按 enabled 管理 IPC/监听、仅保留本次已读取本线程原生保护的终态结果。thread-keyed snapshot 同步防串，late reply/逆序读取不提交；移除组件的独立配置事件 refresh，off 无新 jobs 读取/订阅/操作，notice/error/运行行消失；输出使用既有 FunctionSite 原生 fallback，不保留 guest tree/action。初始 off 与 off reload 不恢复缓存。真实浏览器 15 checks 通过，覆盖历史正文、运行按钮、迟到响应、监听清理、切线程及 disabled 原路径。

- 全量桌面旧 MCP 回检发现真实 assistant 回复重复：OpenAI usage 空尾帧无 provider ID，内部 public stream 给它填入另一层 run ID，外层图因身份不同产生第二条保存记录。两位评审通过最小宿主修复：每次实际 core 请求独立随机 run ID，只将精确对应本次 fallback、已有实际 provider ID、空 AI usage 且无工具的尾帧归回实际回复身份。保留全程无 ID、明确不同 ID（包含合法 run-*）、原 usage/metadata、取消与 opaque-frame 检查，不按文字去重，不改通用保存合并。两项真实 SSE 回归先失败再通过；无 ID 两请求和明确不同 ID 反例通过，3 文件 68 tests。真实 MCP 的严格单回复断言保持不变。
- 助手列表旧 E2E 仍假定公开工具调用标签就是助手身份，而且重复调用覆盖同一行。两位评审核对宿主每次生成独立 UUID 与实际多实例登记后，通过测试迁移：以本次新增实际 ID 唯一定位，数量依次 1/2/3，原运行快照与 audit 使用同一 actual ID；取消和 renderer reload 只更新本次实例，旧 completed/failed 整条记录不变。保留类型、描述、父级、UUID 和关闭后的原生读文件检查；12 组后续真实桌面测试共 73 checks 通过。

完整最终测试与已知失败见 `output/mods-devclaw-continuity-final-report.json`；未完成的附件、规范读取和额外发送入口不标为实现。

最终连续 Electron 236 checks、5 组实际项目/迁移 E2E 47 checks、6 组浏览器交互 57 checks，以及 9 组原有独立测试通过。最终全仓 Vitest 使用 2 workers 串行避开重型 E2E：725 文件中 721 通过、4 失败，5,852 tests 通过、11 失败、5 skipped；11 个失败按文件和完整测试标题与既有基线完全一致，无新增 theme 违规、无 unhandled runtime errors。全仓 ESLint 100 errors 与基线逐项一致，最终改动文件另行无错误；typecheck 和恢复普通 build 通过，out/main/mods-e2e.js 不存在。性能记录为本机 CPU/文件系统场景，不把小幅波动描述为网络或模型速度优化。
