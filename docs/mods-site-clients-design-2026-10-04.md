# 聊天其它位置的交互组件：阶段18设计

用户导入的组件目前能在独立面板运行 Client，但输入框上方、消息、工具记录等绘制位置只能使用静态元素和主模块按钮。本阶段让同一份已批准的 Client 在这些真实位置运行；用户仍按原方式安装、选择、批准，不增加“启动 Client”的操作。开发继续在 codex/mods-v2，UAT 只读；阶段17冻结回归完成前不改生产源码。

## 原版依据与范围

来源是固定 2.1.289 发布包内声明及实际原版 plugin test，完整 SRI、二进制和声明摘要见 mods-latest-289-audit-2026-10-04.md。新增探针位于 output/claude-code-2.1.289-alignment-analysis-2026-10-04/site-client-probe：13 个非 Pane 桌面位置，每个测试加载错误、绘制错误、运行错误和成功异步点击，最终 52 项通过。它是原版测试运行，不能称为官方真实桌面绘制验证。

探针先发现作者 module 属性必须是字符串字面量，改用两处实际声明引用后继续。问答位置替换原控件会被原版拒绝；必须保留恰好一个原生 engine 节点，附加内容不能在它之后。测试底层以原版允许的 ref:0 表示原控件，作者调用 next(e) 后将 Client 放在它上方，52 项通过。初始失败不是本工程功能回归，也不能隐藏这一约束。

本阶段支持已有十三个真实绘制位置内的 Client：AbovePrompt、PromptHint、InfoNotice、Spinner、TurnDuration、SessionMode、UserMessage、AssistantMessage、CommandOutput、ToolUse、ToolResult、ToolGroup、AskUserQuestion。问答位置在 DevClaw 是独立说明区域，固定在真实回答控件上方；Client 只能补充说明或运行自己的按钮，不能接收、替代或提交回答，也不能获得批准身份。仍保留当前原生问题文字与选项身份核验。

完整官方 engine 节点嵌套、原生 ToolGroup/AskUserQuestion 包裹后参数改写不是现基础已经具备的能力，本阶段不得声称这一点。它们是后续可适配项，需要独立设计真实宿主引用，而不是把空 Box 当作原生控件。终端 ToolProgress、终端像素和官方移动端仍无对应实际产品入口。

## 基础与生命周期

1. 所有 Client 使用同一实际 Session 的 FunctionClients 管理器，复用模块批准、隔离 VM、内容保护、真实 SDK 和只读后台入口。不得给每个位置各分配一套不限量管理器；全 Session 八个活动 Client 上限、各绘制八个节点、现有树和消息界限保持。没有 Client 的普通绘制不加载新 VM、不开定时器。
2. 建立宿主固定绘制地址，包含实际 slot、component、requestId 和当前 generation。独立 Pane 的原地址和调用格式兼容；非 Pane 由真实 siteMount 分配 owner，地址采用 engine:owner，不让作者或 renderer 自报 component。Client 稳定实例身份是实际 Session、稳定 slot owner、插件、key；generation 只作操作失效栅栏，不能拼进 identity 导致父重画重启 VM。跨位置不会共用状态；地址不能授予文件、工具或回答权限。
3. 同一 key/module 在父画面重新绘制时保留 Client 状态与已接受 message props；父来源 props 真正改变才替换它们。当前 clients.ts 把 sourceProps 与 parentGeneration 两种变化混在一起会丢 message props，必须拆开并以真实父重画反例验证。删去、换 module、卸载、切会话、重载、撤权或关闭会释放 VM、定时器和旧回调。停止 key 不通过重画悄悄复活。
4. FunctionPanes 提供同一绘制地址和生命周期守卫，site 复用它已有原子发布、callback generation、Client reconcile 过程。实际绘制树通过内容保护后才 reconcile，不让被保护删除的 Client 启动。原生问题/ToolGroup 的状态字段始终由宿主核验；扩展 Client 不新增批准或用户答案回执。
5. load/render/run 错误通知组件真实所属插件；ui.fault 的 component/requestId 来自固定地址。一次自动重画复用原 Pane 的 fault epoch、generation、取消与 fault-born 限制。站点卸载或 props 改变后，旧错误通知不能重画或操作新实例。原生容量、过期操作、审批拒绝不伪装成 Client 模块错误。
6. 错误回执通过实际 sites 注册表查找对应 drawings，不能将任意 engine: 字符串作为可运行入口。Client action 入队、执行与完成前检查父 slot/当前 generation/Client 是否仍被实际保护后的画面引用。控制、message、fault 采用宿主私有操作回执和 signal，固定原实际 slot 对象、generation、instance；守卫进入实际 Hook 的 SDK/core/publish 作用域，覆盖每个异步等待前后，不能只检查 act 的外层入口。后台帧更新只更新 Client 快照，不重新执行整个父 ui.render；匹配 site 局部帧不失效父 lifetime ticket。parent props 更新和取消仍按实际 serial 边界处理。
7. 通知要有实际 slot 范围：ModUiChangeScope 增加 `site:${owner}`，原 `panes` 和无 scope 全局通知不变。每个真实 drawings 复用 16ms 帧合并，并转发自己的 native owner；slot props 驱动的 open 不额外发通知，Client 变化和故障备用重画才发局部通知。只有匹配 owner 的实际站点刷新；普通面板、状态、日志、命令发现与 presenter 忽略这些已知局部事件。未知 scope 保留旧全局兼容，不能将 site 更新发成 panes，也不能让后台动画刷新所有历史消息。最多八个实际活动 Client，不新增无界 owner 通知集合；真正全局 ui.invalidate 仍发送原全局通知。
8. renderer 复用实际 FunctionClient 与 Element，按 snapshot 的受保护客户端表匹配插件/key，不解释作者 JS。站点 lifetime ticket 与 native owner 保留；旧异步 refresh 不覆盖新 props 或其它站点。Client resize、focus、pointer、key 与按钮按原有形式进入 Client，原生问答按钮仍独立。异步控制采用原 pending 计数，不让早先 change 回复解锁另一项点击。
9. 实际 ui.message 与 press/input/select 的 component/requestId 改为地址中的来源，Pane 保持原字段。只有 Client 自己的 element handle 能执行，renderer 不能把其它位置的同 key、instance 或 generation 搬过来。用户点击按当前 native user scope 处理，定时器和自动重画不得继承点击 authority。
10. 宿主版本递增，真实旧许可需按当前摘要重新批准。文档更新当前范围并保留与原版嵌套原生控件的差距；用户操作沿用安装后在对话中的原位置使用。

原 props 改变、父换代、卸载、保护删除该 Client、撤权或真实重绑同步失效旧操作回执。失效的是已进入的操作/通知，不能销毁仍保留同 key 的 Client VM 或重置它的正常状态。之后的新 native tick 按当前实际注册地址进入全新的只读作用域，旧 guest continuation 不得重新捕获新地址逃过失效。共享守卫须覆盖 Client publish/reconcile 返回和实际 Host Hook 内保存、模型、文件及 UI 操作，不能把每次 assertCurrent 改成“查最新 generation”。

## 验证与验收

两位独立方案评审通过后才改生产。先保留现有 Client 被 site 拒绝的失败反例，然后真实 QuickJS/Session 在多个位置挂载相同 module/key，验证状态分离、异步点击、message props、定时器、连续刷新、错位操作、父绘制内容保护删除、停止 identity、加载/绘制/运行失败及一次备用重画。覆盖全部十三个位置的真实 props；至少重点测试输入框上方、消息与问答说明区域。全 Session 容量拒绝不重发点击、不通知伪错误。

真实 React 浏览器验证位置正确、父失效与 Client 帧更新互不混淆、同 key 不串、卸载清理、问答原回答控件保留，普通输入可用。真实 Electron 安装批准实际多模块插件，在输入框上方点击 Client、更新状态、消息回传、触发失败备用内容，并实际检查普通聊天、原生问答、关开、撤权；不增加模型请求的 Client 行为不能进入模型或对话记录。

回归包括原 Pane Client/fault/hold、站点、保护、旧 Plugin、项目、Harness、IM、Goal、Flow/Claw 等受控范围；完整类型与本阶段 lint。性能采样记录单站点 Client 变化不重跑父 ui.render，通知一帧合并且有界；同一实际主机单独执行测量，不用纯数据处理冒充整体界面延迟。最终再取得两位独立代码检视，通过后继续其它可适配项，不结束持续目标。

迟到作用验收必须使用真实主模块 Hook 暂停的反例：在控制或 message Hook 已进入 SDK 等待时卸载/父换代，再放开等待，后续 store/model/fs/UI 操作均为零，不能产生新实例重画。另验证正常同 key 父重画保留状态和 message props，新 native tick 重新进入当前只读地址；用真实主模块副作用与实际 guest/宿主记录，不以假 callback 或模型空计数代替。
