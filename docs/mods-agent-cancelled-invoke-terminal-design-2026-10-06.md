# 普通 invoke 取消后的请求终态

状态：Root 已确认第二次 baseline 的实际缺口，限定两位独立设计审与源码审已通过；Root
已实施 Agent 窄窗并运行下述回归。真实桌面复验仍待运行，不能据单元测试称缺口已交付。
当前生产、测试和桌面 helper 保持冻结；本作者没有执行 CPU 验证。

## 实际问题

pending-reload 第一次桌面失败于 chip 路径预期；其失败清理真正点击 Stop 后，Main 日志
显示 controller 已 abort，随后 activeRuns 已空，实际本地 HTTP handler 的 finally 为 1，
但请求 observer 等不到 done。该次证据没有保存失败时的 terminal 列表，因此还不能把
缺失 done 当作已经完成的动态归因。新 helper 已独立保存等待前后真实列表，成功条件不变。

第二次 baseline 已通过原 chip 路径门，真正 Stop 后仍失败：同一原 request channel 的
terminalsBeforeCleanupWait 与 finalTerminals 都是 []，provider 请求为 1、真实 handler
finally 为 1，aftercleanup Echo 为 0，complete=false。Root 已确认 runner exit1、finally
普通 build PASS 和测试 entry 不存在。记录为 output/stage24-capability-desktop-second-current.log，
完整证据在 output/stage24-capability-desktop-second-20261006/pending-mention-reload；
此处只核计数和终态，不打印正文或密钥。
该动态结果与下述 handoff 后的代码路径一致，不能用取消按钮已恢复 idle 代替请求 done。

实际源码足以说明一个对应缺口：src/main/ipc/agent.ts:7318 在 preparation 完成后
handoff setup guard，随后进入正常 invoke。首模型字节前取消也会进入真实运行的 catch。
10045 的 classifyPhysicalStreamRunFailure 区分 stale/cancelled/error；10237 附近的
cancelled 分支没有发送 done。另一个正常循环发现 signal 已 abort 的分支同样没有 done。
两支最终都在 10265 起 await settlePhysicalAgentRun，后者没有 window/channel 通知。
9715 的 done 只在正常完成分支。6554 的 file preparation onOwnedCancellation 已在
handoff 后退役，不能用它代表此运行阶段的终态，也不能让 agent:cancel 提前假通知。

## 最小生产窗

只改 src/main/ipc/agent.ts 正常 invoke 的局部状态、两条实际取消出口、原成功 done 记录
和本次 finally 中原 settlement 返回后的通知。resume/interrupt、setup guard、公共取消 API、
SDK 和通知/持久化流程不改；不增加生命周期类、注册口或新的 authority。

1. 在该次 invoke 原局部状态中保存 cancellationTerminalPending=false、
   invokeDoneAttempted=false 与 cancelledRequestEligible=false。它们只记本请求的 transport
   路线与通知，不代表权限、释放或成功。
   普通成功分支原 safeSendToWindow(...done) 旁记录 invokeDoneAttempted；原调用顺序和
   次数不改。其后后台维护若又收到取消，不能发送第二个 done。
2. 两条取消出口只有在原 controller.signal.aborted 且
   ownsPhysicalStreamRunLease(threadId, runToken, controller) 成立时记录 pending。
   不能仅因 Error.name/message 被 classify 为 cancelled 就补通知；文字相似但 signal
   未取消的异常仍走原行为。记录应在分支的 trace/fork 等可能 await 的维护工作之前。
3. 新通知只用于真正 desktop 用户请求：原 source=desktop、非 managedExecution、非
   已有 managed session、非原 pluginPrompt/受信内部通知或 workflow notification，且
   本次 streamRequestId 是非空 string。使用原已解析 channel，绝不拼另一条 channel。
   managed 状态沿 7347 本次现有 harnessAgentContext.managedExecution 的计算事实判断。
   该变量在 try 内，catch 不能晚读它；在原赋值后将上述 eligibility 保存到外层本次局部位，
   并在取消支再排除已识别 isInternalNotificationTurn。未走到该点保持 false，不补新查询。
4. 真正 await settlePhysicalAgentRun 正常返回后，再检查 pending、未尝试原 done、实际
   controller.signal.aborted 和 !physicalRunHasSuccessor(threadId, runToken, controller)。
   所有检查与发送在同一同步栈；通过时先标记 attempted，再原 safeSendToWindow 一次。
   如果 settlement 期间已有新 controller 或 turnState.runToken，旧请求不发。

不能在 settlement 后重新调用 ownsPhysicalStreamRunLease 作为条件：正常清理已删
activeRuns、queue owner 和 lease。前面的实际 owner 事实与末尾原 successor 检查分别
覆盖取消归属和清理期间换代。直接复用当前 physicalRunHasSuccessor，它调用现有
physicalStreamRunHasSuccessor 比较 controller/原 runToken；不缓存“身份仍有效”结果。

没有 streamRequestId 的旧调用仍保 ambient 行为。ambient terminal 被 renderer 的
classifyAgentStreamDelivery 忽略，而且不能可靠对应单个请求，本窗不给它补一条可能影响
后继的终态。真实当前 UI 已有独立 request channel；新增成功门需实际核 requestId。

## 清理、错误与范围

settlePhysicalAgentRun 原先等待 runSettlementPhases：逐项真实执行 transcript flush、
message preparer/runtime 释放、controller/queue/lease 清理和 settlement 注册释放。
单阶段抛错仍沿原 report/继续其余阶段的合同；done 表示该请求已终止，不是模型或持久化成功。
不改变既有阶段错误处理，也不以新 done 隐藏 error。未被原 helper 接住的 settlement
拒绝则不执行新通知，保原 rejection；不能在外层 finally 无条件发 done。

原后台 notification/telemetry maintenance 和 void ACL 清理仍按旧合同运行。本窗不声称
新增其物理 drain，不把网络对端 finally 与本地 settlement 视为同一时刻。实际桌面仍在
原预算内独立等待所有对端 handler finally 和本地 scope 清理，不加 sleep/release/timeout。

success、真实 error、stale、Hook halt、内部通知和 managed 路径的原通知及结果不变。
新 pending 两支互斥，原 finally 只运行一次；原 success done 的 attempted 记录只阻止
新增取消通知，不重写或去重其他既有出口。窗口销毁/发送失败仍沿 safeSendToWindow 原处理。

## 实际回归

- 原 pending-reload baseline 必须保存真正缺少终态的 channel。修复后沿同一真实 textarea、
  首字节前 held HTTP、实际 Stop 和原 cancel API：handler 全退、该 request 恰好 done 一次、
  error 为 0，然后继续 keyless/reload/edit/native OFF 完整两请求与 SQL/CP 不重放验收。
- 原正常输出后取消及 mention preparation 的桌面门保留；不能以新增普通 done 替掉
  preparation 的真实 Activity/Reader/handle finally 等待。
- 原 physical-stream-run-setup/run-settlement-fence 单测与 invoke characterization/queue
  plumbing 保留。新增边界核真实 signal + owner、held settlement 未完成不通知、继任发生
  于等待期间不通知、原 success done 后不重发、signal=false 的 AbortError 不升级、
  managed/internal/ambient 不新增，以及 settlement 拒绝包括 undefined 不伪 done。
  可沿现有源码夹具运行该局部出口，不为这些测试增加通用 transport proof 框架。

两源码审后 Root 单 CPU 运行窄回归和真实 pending/guide focus。原五秒门、真实 provider、
完整正文/SQL/CP、所有 actual request done/error 与 app.close 后 Echo 门全部保留。

## 当前验证记录

Root 实际 src/main/ipc/agent-cancelled-invoke-terminal.test.ts 新 9 项、原
physical-stream-run-setup 22 项与 run-settlement-fence 18 项，同次三文件 49/49 通过，
日志 output/stage24-cancelled-request-terminal-first-current.log。新测试从真实 Agent
源码抽取 eligibility、两取消记录、成功 done 和 settlement 后通知，校验真实 finally
中的 await 顺序；执行边界中使用真实 AbortController、队列 owner 与原 settlement helper。
它不启动 Main Electron IPC，也不能证明远端 handler 或 OS 文件资源终态。

Root 另外实际运行原 queue plumbing 52 项与 invoke characterization 10 项，全部通过。
这些是既有源码/行为契约回归，同样不是完整桌面用户验收。两次原 baseline RED 保留；
下一步仍须沿同一 pending-reload/guide 真实 UI、请求 observer、HTTP handler、SQL/CP 和
真正 app.close 后 Echo 门重跑，成功后才补相应桌面结果。
