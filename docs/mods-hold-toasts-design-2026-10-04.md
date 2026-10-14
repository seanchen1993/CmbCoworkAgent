# 看完面板再显示临时提示：实施方案

本阶段承接链接兼容，持续对齐目标保持进行中。用户正在看作者打开的面板时，作者可选择让临时提示先排队，之后再完整显示；不用自己拼定时器或重发提示。

## 官方依据与实际范围

固定 2.1.289 包内声明 7095–7105 行明确：真正显示的 holdToasts 面板会暂存每个插件和引擎的临时 toast，栈不绘制、计时等待；无此面板显示后才释放。2354 行同样规定计时从可见后开始。公开 API 指南见 https://code.claude.com/docs/en/plugins/mods/api。只读提取完整性见 mods-latest-289-audit-2026-10-04.md。

官方 testkit 没有可查询的实际 toast 栈或本机窗口绘制回执，不能用 mock.clock 与 ui.mount 冒充官方真实显示时钟。以固定声明为契约，在本工程实际 Electron 中验证显示、隐藏、释放与剩余时长。当前本工程会直接拒绝 holdToasts，且 plugin toast 创建时就开始计时；这两点需要修复。

DevClaw 可同时显示多个侧栏面板，因此任一真实显示、当前 generation 的 holdToasts 面板都暂停本会话临时提示。依据真实 DOM 与原宿主 Pane 匹配判断，不能把已打开但侧栏隐藏的面板当成正在显示，也不能根据光标焦点推断。各模组临时 toast 使用同一宿主队列；现有聊天核心在 ChatContainer 发出的临时 toast 接入同一显示阻挡条件。普通状态行、审批和问题说明、持久错误文本、其它应用或无真实线程来源的全局 toast 不改成临时提示，也不冒称全部桌面产品已经一致。

## 基础实现

1. ui.open 的 holdToasts 继续只允许 true，省略即关闭；每次 open 都更新该值，ui.open 处理链可以删除它。宿主 Pane 保存它并把真实 generation 的只读显示标记放进快照，内容保护不得伪造/改写它。卸载、替换、close、撤权、重载和全局关闭仍按原生命周期释放。
2. 复用现有 desktopAttach 的 native owner/sender/thread 绑定和 DOM 区域判断。useFunctionDesktop 在真实布局变化、侧栏展开/关闭、窗口可见性和 toast 绘制变化后推送有界呈现报告；一次动画帧合并，无每条 toast 轮询，不为普通聊天创建 Mods 运行实例。报告只能包含固定线程、owner、单调序号、实际 Pane key/generation/shown、实际已显示和悬停的 toast id；不能设置内容、持续时间、执行权限或审批结果。
3. 新呈现入口验证 writableScope、真实窗口 owner、当前会话实例和最新序号。宿主只认可当前 Pane 匹配的 holdToasts；迟到/异线程/旧 owner/旧实例回执丢弃。toast id 只接受当前会话已经内容保护并发布的实际条目；原保护删去的文字不能因为一条显示回执重新出现。呈现数据不作为模型、文件或操作 authority，SDK 不提供该私有入口。
4. FunctionUiFeedback 保存有界队列和每条剩余时间。新 toast 不在创建时计时，只有收到真实可见回执且没有停驻面板才启动；连续正常重画不重置期限。显示中再次停驻、窗口隐藏或悬停时暂停剩余时间，恢复后继续；按 id 明确取消只移除这一条，不影响其它条目。旧每插件4条、会话40条、UTF-8总量限制保留，pending同样计入；超过上限丢最老临时条目，结束全部清空。
5. FeedbackSnapshot 增加宿主固定的超时时长信息供绘制，不新增插件设置入口；所有内容仍保护、所有身份和时长仍固定。renderer 在真正显示 holdToasts 的 Pane 时不画 toast，状态行继续显示。呈现回执在 DOM 完成布局后提交；未挂载/被隐藏的 toast 不被误算为可见。toast 增加易点击的关闭按钮和悬停暂停，沿用现有配色，不在对话框增加配置控件。
6. 当前聊天核心的临时提示通过线程绑定的 renderer 队列进入原 Sonner 展示；停驻期间不调用其展示函数，释放后 FIFO 交给原组件，从实际展示时计时。其它未阻挡情况下直接沿用原方法、文案和样式；保留调用选项和返回 id，取消不得重放已取消项。对没有线程来源的全局通知不猜来源，不把另外一段聊天的提示释放到当前聊天。队列与实际挂载 owner 绑定，卸载时丢弃旧队列；全局 Mods 关闭不妨碍当前会话原通知。
7. 插件 toast 与本会话引擎 toast 共用“是否暂存”的实际呈现状态；各原有视觉位置保留。引擎未识别的其它入口继续记录并逐一适配，不把本阶段有限范围声称成全应用所有通知。持久审批与错误始终使用原 UI，不受作者 holdToasts 控制；作者只能影响临时提示的展示时机，不能改变任务或审批。
8. 宿主行为版本递增。无作者使用 holdToasts 时不引入模型请求、隐藏配置扫描或新的后台进程。旧 Plugin、项目、Harness、IM、Goal 执行入口和任务状态保持原来含义。

## 验证与复核

实现前取得两位正式方案评审。先补失败反例：holdToasts 真值原来拒绝；创建即耗尽和未展示就过期；旧 owner/generation/回执不能影响新实例。共享边界、假时钟队列先验证剩余时间和容量，之后真实 VM/Session 验证 ui.open 多模组、移除 holdToasts、关闭/替换/撤权、保护删改及生命周期。

真实 React 验证侧栏实际显示才阻挡、无焦点也阻挡、切换线程不串队列、隐藏标签不启动时间、hover/dismiss、状态行和原审批仍可见；引擎临时通知应在停驻时零 Sonner 展示，释放后只有一次。实际 Electron 安装批准两个模组，一方开停驻面板另一方发 toast，实际等待超过 timeout 后关闭面板仍能看到完整提示，再按真实时钟消失；同时实际 Goal/聊天核心临时提示、普通聊天与原审批回归，保存截图和时间证据。

跑邻近、冻结受控广域、Node/Web 类型、本阶段 lint；测布局报告数量/消息数和大量通知上限，不把假时钟或浏览器 mock 外部桥当真实网络/模型性能。两位最终实现检视通过后，继续其余 Client 绘制位置、输入提交、消息写入等尚可适配项。目前没有新的框架限制结论。

这是待评审方案，未将未实现能力计为完成。上一阶段冻结回归已通过。

## 两位评审后的确定机制

私有反馈发布与普通 SDK 分开：主进程只读取已驻留实际 Session，执行现有内容保护，再由 desktop broker 签发随机 publication receipt。receipt 固定当时的原 owner 对象、实际 Session 对象及保护后可见 toast id 集合；每次发布替换集合与 receipt，不累计。调用前后再次检查同一 owner 与 Session，renderer 只回传这份 receipt、序号和有界布局结果。旧 owner 字符串复用、重载后的旧空报告、保护删掉的 id、异线程/异 sender 都零影响。detach、重新 attach、当前 Session 退休立即暂停原时钟，不能在收包时替旧报告补上新 Session。

主进程用 performance.now() 单调接收时钟计算剩余时间，不接受 renderer 时长。报告中的 Pane 必须匹配当前 native key/generation 且已保护发布；hold 属性来自宿主固定快照，不信报告内的标志。新发布先暂停被移除的 ACK 集合，仍存在的条目也要由这次 receipt 确认，正常显示刷新不重置剩余时间。content-protection 拒绝不能沿用旧内容或继续计时。

呈现判断采用窗口可见性、元素及祖先的 hidden/inert/visibility/display、视口和各 overflow 裁剪祖先的区域交集。不是仅判断 getClientRects 是否存在。布局后一次 rAF 合并，按语义内容去重，seq 不进入内容指纹，但新 receipt 即使布局相同也确认一次；MutationObserver 只读相关 pane/toast 区域，scroll/resize/visibility/hover 事件触发，空普通聊天不发周期报告。这里准确称为 DOM 布局呈现确认，不宣称它证明了 OS 实际绘制。

聊天核心 adapter 保留 Sonner 外观，只接 ChatContainer 内有真实线程来源的 success/error/info/warning/message 临时调用；外部全局入口与持久 loading/promise/Infinity 不猜来源。Mods 关闭时直接用原调用。启用时队列最多每线程 40 条、512KiB，同时全 renderer 最多 160 条、2MiB；超限先移除最老临时项。卸载时明确丢弃该挂载 owner 的待显示/已显示条目，不在新线程或恢复会话中重放旧提示。

adapter 按 FIFO 一次仅提交一条本线程提示，调用原 Sonner 时将自动 duration 设为 Infinity，由私有单调时钟管理原有限 duration。必须等 actual Sonner DOM data-visible、挂载与裁剪均满足才计时；不能将 toast() 调用或被隐藏的尾部当作显示。当前已提交的提示进入 hold/隐藏/hover 时只隐藏并停钟，恢复原 id 和剩余时间，不 dismiss/recreate，避免重复取消回调。到期调用原 dismiss 并准确区分 auto-close/user-dismiss；队列取消无需先调用 Sonner，options.id 更新、返回 id、原选项及取消回调只消费一次。持久提示和其它无来源 toast 始终走原路径。

共享 presenter 同时报告插件队列与本线程 engine 阻挡状态；插件最多展示有界批次，滚动裁剪外的条目不启动时间。若没有 receipt，插件条目不能开始计时，engine 仍只依本线程已保护 Pane 的实际 DOM，不分配新 Session。配置重绑暂停并取得新回执，回执/保护异常显示不继续旧 transient 内容。新增全部机制先作 owner/session/保护/时钟/取消的红反例，再做真实 Electron 等待超过 timeout 的显示验证。

两位更新方案正式评审通过。Sonner 的本线程提示使用它现有 toasterId 定向到独立挂载的同款 Toaster，位置、配色和样式沿用现有配置；hold 隐藏该定向容器，不占全局默认 Toaster 的 visibleToasts 容量，也不隐藏无来源全局提示。启用时此轻量容器随 owner 保持挂载，空时没有通知卡片；实测发现 Sonner 不回放挂载前发出的事件，不能随 pending 归零卸载后再同步发第一条。关闭 Mods 时不挂载。最终实现继续由两位独立检视。

最终复核补充：定向 Toaster 挂载到 body，避开聊天壳的滚动裁剪和固定定位包含块；真实 Sonner 的固定定位提示不能被普通 overflow 祖先误算为隐藏。保留相同位置与主题，切会话清理原 owner。公开 ID 在原持久提示与暂存路径间更新时，先移除同一 owner 的旧表示，不产生旧取消或到期回调。主进程必须先严格验证原始呈现报告，再套原生窗口隐藏掩码。

取消标记不能因私有 IPC 返回成功而清除：旧 receipt 的 ACK 可被静默忽略。只在新的内容保护快照确认条目已不存在后清理；若仍存在，就随新 receipt 再报告取消。这一竞争分别用实际宿主 publication barrier 和真实 React 失效回执页面反例验证。renderer 路由在布局阶段更新并于卸载退休，不在 render 直接修改 memo 对象。实际 BrowserWindow.hide/show 与 renderer 无动画帧隐藏分别验证暂停；DOM 确认仍不代表 OS 绘制证明。
