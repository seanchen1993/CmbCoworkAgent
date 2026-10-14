# prompt.mention 实际桌面输入与队列 E2E 设计

状态：仅设计，20生产与7单元测试保持冻结；CPU由Root执行。沿现真实
`tests/mods-e2e.spec.ts` controlled Electron runner新增独立 focus `prompt-mention` 和
`tests/support/mods-prompt-mention-e2e.ts`，普通 build 最终恢复。不是从 page.evaluate
手构 composerSubmission、OwnerToken、Scope、receipt 或 queue payload来代替实际输入。

## 实际测试接点

测试在runner的隔离 CMB home/workspace内生成普通文本 fixture，再通过原
window.api.plugins.install + mods.approveFunction 安装实际digest的 plugin；原真实models
配置只指向本进程 localhost Chat Completions server。之后所有 mention 发送都操作
`textarea.composer-textarea` 与真实发送按钮或忙时原 Enter；没有 fixture SDK
prompt.mention 或虚假读结果。

插件真正 `prompt.mention` Hook固定原mention，可按fixture名字改写path/offset/limit、
返回包含重复字符串的context，或在真实next后deny。实际 `prompt.attachment` 原事件
继续执行。可以在返回context写入测试marker与被收到的已固定e字段；它只观察这次
真实事件，不作为权限、OS读证明。首Core一次另由真实 stable-file open/read 的只读
observer核：在测试 entry 中保存原方法地址，Reflect.apply同原参数/receiver仅一次，
返回同原Promise/handle，记录固定方法名+计数（不改read/stat/guard/result/权限）。如
既有entry无法共享真实模块地址，先在Source核这项，不用模块名字或重复bundle造observer。

Main终态沿现 observeNativeAppendTerminals 的真实BrowserWindow/streamRequestId+原send
委托同结果观察。HTTP server记录实际请求；原SQLite history/Checkpoint通过实际
window.api.threads.getMessages/getHistory读取，SDK trace可辅证但不代模型请求或Core读取。
服务器仅控制真实SSE答复或cancel socket，不造Main keeper/protection/canonical票。

## 首focus的可执行场景

1. 普通 @ before-read：填写 `MENTION_NORMAL @normal.txt#L2-3`，真实Hook把path改到
   replacement.txt并保offset2/limit2，重复调用next仍同outcome。首次实际HTTP严格包含
   replacement的两行完整内容/实际XMLpath，缺原normal正文，context重复项完整；实际
   stable open count1/mention event1。durable user与真实CP各只有同一个input id，最终
   assistant只有一个；UI不展示隐藏context。读取之后改动原文件不能倒填此次已读版本。
2. mixed upload + deny：通过原composer DOM drop handler送入真实浏览器File（由本地
   fixture bytes构建，走原 bytes上传/attachment formatter，不塞filePath或正文到IPC），
   同时真实键入 `@deny.txt`。Hook真next后deny，实际HTTP保完整上传正文/XML与用户文本，
   不含deny文件正文/deny附加context。使用真实正文分别计原3件/24k预算；不截mixed文字，
   也不强塞plain prompt.submit。再次正常file-only deny时0HTTP且明确drop，草稿/提示按
   实际UI原协议检查，不能把无请求误当成功模型结果。
3. busy FIFO与真实编辑：先发送普通实际用户请求，server持其真实response而不结束；
   在显示停止生成期间输入 `MENTION_QUEUE @old.txt` 并Enter，看到真正排队卡片。此时
   Core open/event0（只收集未读引用）。用卡片 `title=更多`→`编辑消息`→textarea→保存
   把typed引用改成new.txt，已有chip仍保。在真正发送前改new文件正文，然后释放server；
   自动FIFO使用new路径最新正文，不读取old，下一HTTP与保存的input/CP全文一致。
   再排第二条证明先后次序、每条id仅一个，不能凭model-request数量猜成功。
4. 还原/持久性：在busy draft已park时切到另一实际线程再切回来，从原队列存储恢复
   该同id/version/未读路径。FIFO完成后page.reload，再用真实sidebar选回thread；完整
   user/assistant行、上传/mention正文、CP全部相同且provider count不增加。若reload自身
   对active run有不同原生命周期，另记录并使用真实Stop结束后再验证，不通过手改React
   store/localStorage状态逃过原owner逻辑。
5. Stop/cancel：插件对cancel.txt先真next再await原clock.sleep；从真实textarea发送后
   点击真实 `停止生成`。核0model HTTP、0durable admission/无伪成功assistant，实际
   timer/Core/handle finally结算后终态才收集完成；保原queue停止/草稿行为，之后再正常
   发送一条，证明旧任务没有迟来context/body或跨run写入。不能用取消shell先返回当
   resource已退出，所有observer/server/socket在finally中独立close/全观察。
6. Mods OFF：通过原开关关闭，再真实键入@legacy.txt。沿存量renderer
   workspace:filePreviewRead读取，原附件XML/清洗后的@文字与旧golden严格比较；mention
   Hook/event0，但正常HTTP与assistant/保存行完整。此前canonical/input history保原id，
   重新打开不会把旧已读附件伪称新mention read。

每场景保实际权限/审批与Source：不打开YOLO，不从plugin自称type/agentId给予读取，
不删错误终态或完整正文比较。模型用已知测试literal，输出evidence/screenshots仅隔离
artifacts，不输出用户凭据。outer until/watchdog沿现runner；单元原5秒门不改，server
故意held时间与应用性能数据分开报告。只有真正complete+allactualrows/terminals才PASS。

## 精确实施文件与资源

首窗只新helper、tests/mods-e2e.spec.ts新增import/focus分支，以及若确需实际Core observer
则tests/support/mods-e2e-entry.ts仅观测导出。不写业务20源；entry只能增加测试计数与
实际Promise保存/truefinally观察，不能暴露OwnerToken/privatecap或可注册callee。
Root持有spec/entry时由其窄接，helper单独owner。主finally在真实UI Stop后等待所有已发
request/observer实际finally，独立移除observer/关闭HTTP，再记录evidence；不提前DBclose。

## guide另一个实现窗口

当前 ChatContainer的CURRENT_RUN_GUIDE_UI_ENABLED=false，原原因是Team/Coordinator
live transcript边界错误。首focus保原flag，不调用page.evaluate queue IPC冒称真实UI引导。
完整guide需要单独基础：Solo、Team、Workflow各自真实Host/window/currentauthority原
handler integration，真正guided user及后续assistant两个独立id/行、不重复/不挂错turn；
reload/CP同实际保存行，全原Goal active拒/approval/source/lease/controller/opaquequeue
换代门保。找到原actualdisplay-boundary接点后写精确修复与回归两审，三mode全绿后才
恢复真正按钮，并追加相同textarea→busyqueue→引导click的真实E2E。不是blind flip，
不是框架限制；此部分是持续补齐的用户能力，首focus不能声称已完整验证guide UI。

## 自动完成与真正发送操作的测试微修订（待两审）

Root第5Desktop首typed场景的完整HTTP/CP/实际Guest审计已通过；混合第二条停在原
textarea，新增agent IPC0，deny.txt被选成chip且MENTION_MIXED文字仍在。源码中
handleKeyDown先处理at-file Enter：只要有suggestion就applyAtFileMention并return，
没有执行handleSubmit。当前helper fill→Escape→Enter没有证明Escape保持关闭；
useAtFileMentions的dismissedKey可在currentKey变closed时被同render重置，所以这不是
Main保护、文件Owner或附件BODY的失败。该生产UI关闭行为另留独立回归，不在本次
冻结时顺手修改useAtFileMentions或发送/队列逻辑。

最小test-only窗口仍只有tests/support/mods-prompt-mention-e2e.ts：

- idle submit保原fill(text)完整typed文字/路径，改点真正aria-label“发送消息”的原
  submit按钮；该按钮走同表单handleSubmit/原确认/完整collector/权限/IPC流程。
  不force click、dispatch submit事件、手造DTO或直接调用IPC，不修改原text来制造成功。
- file-only场景仍真正点击popover option形成chip，再点击同实际发送按钮；完整
  deny/drop/终态/HTTP0/rows不变门保，不能用手造payload替被选中的真实文件。
- busy时没有发送按钮，保真正Enter排队。只为两条原busy草稿另建park(text)：真实
  fill(text+一个空格)，确认原inputValue与popover option消失后press Enter。尾部空间
  是正常输入分隔符，使当前光标不在@token中；原submitPreparedInput的
  submittedDraft.text.trim()恰恢复原完整text/typed路径，队列卡片与保存JSON必须仍
  含原未读ref，原beforeSwitch/edit/FIFO/Core0及HTTP/CP完整字节断言不降。
  不用Home单键自称已更新hook光标：当前textarea没有onSelect触发状态更新，不能
  靠一次光标移动或计时sleep证明popover已关闭。

这三个接点不增加模型/审计请求，不改原6完整HTTP/8唯一invoke channels/exactdone/
error0/CP/所有BODY/context/IDs/Echo/真cleanup。只有test真实UI触发方式变化；生产
权限与主链保持冻结。Root actual finally/ordinarybuild恢复且两设计票后才原子落
helper微修，再由Root重跑首完整focus，不把已通过typed子场景称整组已绿。

## Escape 关闭状态的独立产品修正（Root 候选，待双人评审）

上面的按钮方案只修测试操作，实际用户仍会遇到 Escape 后菜单重新打开。本次继续
迭代因此优先修产品关闭状态，未批准的三处 helper 操作改动暂不落，原 Enter 排队、
发送和全部正文断言继续。唯一产品窗为 useAtFileMentions.ts，新增同目录回归。

当前 activeToken 同时负责识别引用和应用 dismissedKey；dismiss 后它直接变 closed，
再用显示 mode 计算 currentKey，导致 key 从引用变为 closed，render 中把 dismissedKey
立即清空。改为 rawToken 只按原 input/cursor/disabled 识别，原提取规则、规范路径和
边界不变；activeToken 单独按 rawToken.key 与 dismissedKey 决定是否显示。
currentKey 从 rawToken 计算，原选中项和关闭状态只在实际引用发生变化时重置。
同一个引用在搜索结果、workspaceFiles 数组或普通重新渲染后继续关闭；输入改为新
引用或离开引用时恢复原候选选择行为。搜索、取消、文件访问和发送函数均不改。

新增 useAtFileMentions.test.ts 使用真实 React server render 的 useState/useMemo
重渲染核关闭后不重开、相同 query 新 files 列表不重开、新 query 重新打开、离开后
重新输入恢复、quoted token/disabled 变化和选择重置。它只证明实际 Hook 状态更新，
不声称 SSR 执行了 useEffect 或浏览器文件搜索；真实异步候选和原 Escape→Enter
发送由 Root 完整 Electron focus 再验，不增加固定等待或改成直接 IPC。

若需在 helper 加观测，仅在原 Escape 后检查真正 option 消失，再原 Enter；全部
6 HTTP、8唯一invoke、原BODY/context/队列/权限/CP/ID/终态与清理保持。
## 第六轮取消失败的只读时间诊断（Root 候选，待双审）

第六轮真实发送、混合附件、file-only deny、忙碌FIFO编辑和刷新均通过，取消时
Stop locator超时。失败截图在15秒后，不能证明5秒Guest sleep期间按钮从未存在。
原SDK在transport前已发布loading=true，Main在prepare前也已有真实controller。
因此先不增加产品busy状态；确定的取消后结束通知缺口另外设计。

下一次只改原 `tests/support/mods-prompt-mention-e2e.ts` 取消段的诊断观察：在原submit前
通过真实page.evaluate安装DOM MutationObserver，记录停止生成按钮的presence/disabled
状态改变及实际时间；不修改DOM、React状态、localStorage或业务API。仅状态改变记录，
不保存正文、模型凭据或内容，不将DOM观察作为运行授权。audit原调用前后和Stop click
前后同时记录真实时间及按钮状态。成功或失败均将完整时间线保存到该focus证据，原
finally独立断开observer，即使取证失败也不掩盖原失败。

原submit/Escape/Enter、5秒sleep、sleep-entered且尚无finally的审计条件、15秒locator、
原0模型/0durable、真实finally/terminal、6次完整provider及8channel门全部不改。
只读诊断不能代替修复或取消验收，不能因此把前次complete=false改成通过。
