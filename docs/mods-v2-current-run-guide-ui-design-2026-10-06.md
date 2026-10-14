# 恢复当前运行引导的用户入口

状态：本次只修订设计，未修改生产代码、helper、spec 或 entry。当前
CURRENT_RUN_GUIDE_UI_ENABLED=false，用户仍看不到队列中的“引导”。本方案以对应
用户能力、原权限和数据完整为标准，取代旧稿要求所有模式乘所有 provider 名称/ID
组合、先完成内部逐帧同构才恢复按钮的前置矩阵。Root 独占实际测试和构建。

## 用户行为与已有证据

运行中输入的新消息先成为可编辑的队列草稿。点击“引导”将同一草稿交给当前前台
运行，在下一次模型调用边界接收；不会中断工具、跳过审批或把后台子任务变成前台。
引导前 assistant、同草稿 id 的 user、引导后 assistant 分别显示，正文完整且不重复，
保存和 reload 后还是同一组记录。

正常聊天、Multi、协调和 Workflow 的前台运行复用现有入口。Multi 在 Main 是
normal + subagentsEnabled=true，协调是 coordinator。只有后台 worker/workflow、
没有可接收的前台运行时，保留原“提到队首”行为；这是普通草稿优先级，仍受 idle、
审批、Goal 和权限门控制。run_not_ready 保留草稿提示重试，不当 no_active_run 重发。

tests/support/mods-continuity-e2e.ts 的 busy steer 已通过真实 renderer IPC 调用 Main
agent:queueCurrentRunMessage，观察 queued=true、改写 visibleText、真实 HTTP 隐藏
上下文和同 id 的 SQLite user 行。实际记录在 output/mods-continuity-electron-final.log
的 Busy steer PASS。它证明队列与预处理能力，不证明隐藏按钮的点击，也没有精准
核对前后两个 live assistant 气泡。

现 canonical current-run integration、queue runtime/plumbing、queued content、
Electron transport/reducer、holder continuity、审批/取消回归继续复用。native append
和 mention 的桌面记录作为持久化、terminal、资源清理基线，不冒称已证明引导边界。
新窗只补真实按钮与用户可见结果，不重建 Main 队列、Source 注册或 SDK，不将所有
provider 组合或每模式额外启动一套子任务作为按钮前提。

## 最小生产与测试窗口

候选生产仅 src/renderer/src/components/chat/ChatContainer.tsx：约 1044 行 false gate
恢复，旧注释更新为实际能力边界。约 6275 行 handleGuideQueuedMessage、约 8673 行
原按钮、queue claim、Main IPC、formatter 原样保留。两设计审后另授权修改；当前无
生产写授权。

NEW tests/support/mods-guide-boundary-e2e.ts 使用简单 API：

    verifyGuideBoundaries(app, page, workspace, artifacts, until, pass, logPath): Promise<void>

Root 独占 tests/mods-e2e.spec.ts 的 guide-current-run focus、dispatch、真实 app.close
后证据门。现 terminal observer、HTTP、公开 threads API、CP 观察和 live DOM 足够，
不改 tests/support/mods-e2e-entry.ts。只有真实 RED 确需定位，另审原 send 的同一
实际委托只读观察，不添业务 callback。

候选 gate 与 helper 在同一可运行源码审核窗口完成，两源码审后 Root 构建真实 UI
快照，直接点击按钮。测试前恢复入口不等于交付完成；实际 RED 只修复已复现的界面/
传输/队列接点，不追加内部同构体系。最终交付以以下普通能力门为准。

## 四种前台的真实按钮验收

各场景独立 thread 和真实合法配置，不并行改同一 queue owner。沿真实 endpoint、
approved Guest、textarea 和发送按钮启动首条；HTTP gate 持有第一前台 response。
第二条由真实输入框 park，只读该界面生成的 id/version 作观察，再点击同卡片“引导”。
不能调用 API 自造草稿代替点击。

| 场景 | 真实设置 | 必须证明 |
| --- | --- | --- |
| 正常聊天 | normal，subagentsEnabled=false | 同草稿一次接收，前 AI / user / 后 AI 分别显示 |
| Multi | normal，subagentsEnabled=true | 前台接受同草稿，保原父/child 隔离和开关 |
| 协调 | coordinator，原允许的会话来源，一条真实 worker 回复 | 前后协调回复分开，不混入 worker 内容 |
| 流程 | workflow 的前台回复 | 当前前台接收，后台 leaf 不消费父草稿 |

先每模式一条常见前台路径，每个主要回复两段真实 chunks，使用一个正常合法的
provider ID 方案。reuse/idless/晚帧的原 converter、reducer、canonical 门继续跑，
不把全组合作为入口前提。若实际模式自然启动 worker/workflow，保原 schema、工具
和批准 UI；不 fake 角色、不跳批准。协调一例保留真实 worker 来覆盖旧注释指向的
现场错误路径，不要求其它每个模式再启动全套子任务。原 child/worker/workflow 隔离
门复用，不为了按钮重复完整能力矩阵。

释放 HTTP 后，从实际 SQLite rows 取得 id，在原 data-chat-message-id 和
data-message-role 上查：前 assistant、同草稿 user、后 assistant 各一个；正文各自
完整且不交叉拼接。虚拟列表正常滚动定位，不拿 body 总次数当身份。核整个 rows
id/role/order/content、CP 消息和下一次模型 input。reload 后深等，HTTP 不新增，
草稿不重放。

## 后台和失败路径

Main 没有 activeRuns 时仍返回 no_active_run；Renderer 清本次 handoff，调用原
promoteQueuedMessage/queue pump，提示“已提到队首”。不增加背景 guide API，不让
worker thread_id/workflow leaf 消费前台队列。原 runtime/plumbing 隔离与 queue 顺序
门继续覆盖；可复用现实际后台 fixture 补一例点击后 priority 变化、0 额外注入/模型/
正文覆盖。不伪造 activeRuns/owner 宣称真实后台窗口已验证。

原 controller/preparer/runToken/queue owner、withdrawn/already_injected、Goal、
权限和 final file B/data commit 门不变。normal 至少真 Stop 一例，terminal 后无
晚注入/重放；原审批等待/拒绝、owner replacement 与现真实批准路径复跑，不扩成
四模式乘全部负例。ask/deny/工具效果计数保持，失败按原合同保留或提队首；
run_not_ready、Hook block、撤权不能当成功。

文件引导复用 structured submission、Owner/activity/stable FD/whole FS B 和
logical/canonical 门。normal 至少 mention 或 mixed upload 从真 park 到按钮点击，
核完整正文和 CP；原 FIFO/edit/restore/cancel 不减。plain 引导不能冒称文件通过，
也不要求旧文件预览所有极端内部行为同构。

## 验收与交付

业务原 5 秒门不变，HTTP hold 与桌面 watchdog 单列。helper 保存完整 HTTP/rows/CP
baseline、实际 terminal，error 不被随后 done 覆盖。关闭后 HTTP 不增加、Main log
Echo 四固定枚举为 0。handler/socket/server/observer/app 独立清理，首失败含
undefined 不丢。结果分清前台、后台 priority、文件引导与已有复用回归。

顺序：Root/Legacy 审窄稿 → 另授权 NEW helper 和 one-gate patch → 两源码审 →
Root 实际四前台/live DOM/DB/CP/reload、normal Stop 和必要文件例 → 原 queue、
transport、canonical、审批/取消回归。实际用户结果完成才称入口恢复，不再以内部
全同构或全 provider 组合无限推迟。当前只文档，没有 helper/生产/测试写入。
