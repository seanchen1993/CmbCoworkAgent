# Claude Mods 2.1.289 再核验

本轮实际下载、检查并运行了官方 Windows 2.1.289 发布包。此前 2.1.288 的结论继续保留为历史证据，不改写成新版本测试结果。

[官方功能参考](https://code.claude.com/docs/en/plugins/mods/reference)目前注明 2.1.289，并提醒 GitHub 的声明可能较旧，以安装版本的声明为准。[官方 API 说明](https://code.claude.com/docs/en/plugins/mods/api)用于核对用法。

## 可以复核的原始证据

目录：`output/claude-code-2.1.289-alignment-analysis-2026-10-04`。

- npm 的主包及完整 Windows 原生包均校验发布方 SRI；原生包为 113109304 字节。prepare_verified.py、unpack_packages.py、extract_bun.py、decode_assets.cjs 和 compare_contract.py 均完成。
- 实际 claude.exe 的 SHA256 为 `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`，实际 --version 返回 `2.1.289 (Claude Code)`。
- 从此二进制提取并解压的声明 SHA256 为 `791464683ba02b5905d477fdb2fe9a81a5110c937bc28bae21414657d53a9894`；kit 模块 SHA256 为 `20de9e6abf0e04968db029d9a4880edc4ab45d173d315a212bd0e89dcdbff119`。定位与完整性见 manifest.json、declarations-integrity.json。
- Bun 清单 2394 个模块，其中 2165 个是字节码占位，无源码映射。可以检查声明、部分可读模块和实际原版运行；不能宣称完整还原了闭源运行时。
- 与 288 的声明差异为增加 301 行、移除 77 行，见 embedded-declarations.diff、static-delta.json。
- 原隔离测试有 24 个不同用例，关闭和开启实验开关各跑一次，共 48 次通过；见 probe-results.json。不把它写成 48 个不同功能。
- 新 Client 故障测试 10 项通过，见 fault-probe/tests/fault.test.ts、fault-probe.log、fault-probe-result.json 和 output/mods-289-fault-identity-forced-qualified.log。使用原版 plugin test，不含真实 Claude Desktop 绘制或模型调用。

## 这次确认的使用变化

组件加载、绘制或点击处理失败后，所属模组能收到 ui.fault。错误通知只有观察作用；所属模组可以在下一次绘制时去掉坏组件、改显示备用内容。自动恢复只重画一次；在这次恢复中刚创建的组件再次失败，会通知作者，但不继续循环重画。

异步点击可以正常完成并更新组件状态。点击处理拒绝是 run；点击成功后新的绘制抛错是 render。这两种情况必须根据实际执行步骤判断，不能根据错误文字猜测。绘制函数本身仍按同步返回树实现。

同一个 key/module 的已停止实例，在自动和显式父面板重画中不会随意复活。实际探针强制改变父 props 后确认 ui.render 再次执行，但同一个失败实例没有第二次故障通知。换 key 产生新实例则可以再次通知；恢复过程中出生的实例第二次失败不会再次自动重画。

首次异步成功用例失败，是测试只查父树的错误。使用 find({ in: "bad" }) 查询真实 Client 子树后通过；失败日志保留为 fault-phase-attempt-7-tests.log、fault-async-diagnostic-attempt.log、fault-async-redraw-attempt.log。不用人为延时或额外 redraw 隐藏问题。

## 接下来的适配

先补实际组件故障通知、一次恢复与异步点击。之后继续其它绘制位置的 Client、无效 Link 显示普通文字、面板停驻时暂存通知、插件主动提交输入和追加消息等已知缺口。队友身份和状态必须接实际任务业务，不能把普通子任务 UUID 当团队地址。

输入编辑网页写 50ms，288/289 包内 HookBudget 仍写十秒，尚未取得可证明原版 prompt.edit 特例的实验；不凭网页直接修改底层预算。取消五秒后仍未退出的 Hook 诊断，需要真实 guest 完成回执，不能将宿主传输残留当成 Hook 仍在执行。

以上未完成项不是已确认的框架限制，持续目标仍进行中。

## 链接文字化的追加实证

固定同一 2.1.289 原版实际 plugin test 最终 46 项通过（desktop/mobile 各 23 项），日志 output/mods-289-link-authority.log。测试精确核对 Link/Text 类型及原始 href：构造器仍要求字符串，原始树的无效地址显示文字，合法无尾斜线 HTTPS 保持可点击。包括空 authority 的三/四斜线反例；不把测试绘制结果冒称为真实桌面系统打开。

本工程对应阶段已完成，回归、性能和实际 Electron 证据见 mods-link-fallback-stage-2026-10-04.md。继续停驻通知与其它可适配缺口。

## 提示暂存与其它位置 Client 的追加核验

本工程提示暂存阶段已经通过两位最终静态检视、380文件3317项受控回归与18个真实Electron检查点，详见 mods-hold-toasts-stage-2026-10-04.md。依据的是包内声明和官方 API 契约，不能称为原版真实桌面显示计时对照。

新建 site-client-probe，对固定同一289二进制实际 plugin test 运行十三个非Pane绘制位置，每个加载、绘制、运行失败与异步成功，最终52项通过。日志 output/mods-289-site-client-original.log，runner、fixture和结果均在当前原版分析目录。编译器要求 Client module 是字符串字面量；问答窗口要求恰好一个原生engine节点且后面没有附加内容。以测试底层提供原版 ref:0，作者 next(e) 保留原控件并把 Client 放上方后通过。初始违规和缺底层实现的失败没有计为工程回归，也没有包装成绿色记录。

本工程下一步设计见 mods-site-clients-design-2026-10-04.md。实际问答说明区保留原回答控件；完整原生engine节点嵌套仍需后续真实引用设计，不借空Box冒充已完成。持续目标继续，目前没有新增框架限制结论。

## 十三个位置的工程验证与主动提交新证据

本工程十三个位置的 Client 适配已完成，含真正的局部 IPC 通知、原生问答控件保留、撤权后普通聊天正向收发。382文件3348项受控回归和真实Electron30检查点通过；完整范围、性能和失败账本见 mods-site-clients-stage-2026-10-04.md。完整原生engine嵌套仍未完成。

同一固定289二进制实际主动提交探针8项通过，日志 output/mods-289-prompt-submit-held-core.log。runner和可复跑夹具在原版分析目录；检查来源、asUser、同插件调用规则精确跳过、合法最终答复省略origin以及正常/可恢复错误后已进入下游仍不取消。原源正常返回后公共Promise的then尚未执行，不能将下游已进入写成SDK已经取得真实启动回执。底层为测试提供的受控等待，不证明官方真实空闲调度、模型启动或持久化。

早期实际失败还确认原生host check拒绝在command.run和prompt.submit规则里调用SDK，即使void也拒绝。第二轮错误是test Hook参数写错，第三轮还错误地把所有wildcard事件计数当作调用数，以及把下游已进入当成then已执行；修正后分别验证。失败日志全部保留，不能凭网页描述省略这一实际源限制。接下来的工程设计据此调整，见 mods-plugin-prompt-design-2026-10-04.md。

## 主动提交来源与界面基础的补充实证

固定289原版实际界面来源第五轮14项断言通过，`output/mods-289-prompt-source-ui-fifth.log`。捕获旧SDK在命令中调用的两个用例已有零child core和实际host check断言；第四轮这两个用例只做诊断，不算完整证明。另有其它真实来源矩阵12项、实际 recurring 回调2项和 turn.complete 2项通过。普通源提前解除30ms后信号仍未取消的1项反例，只证明该实验窗口；没有取得真实原版Stop/卸载对照。

本工程对应实现已经通过14个实际Electron检查点（其中1个公共开关检查），实际安装示例ZIP、忙时等待、自己的开发轮完成后一次检视、真实HTTP、来源、撤权/重授和普通聊天均验证。最终广域收尾记录在 mods-plugin-prompt-stage-2026-10-04.md，不把testkit受控core当成官方真实调度。

原生 engine 新研究有10项契约断言和10项诊断，严格分开；未知ref实际回退当次原输入，不能宣称原版跨draw整数必然拒绝。完整树迁移、内容保护和Ask真实控件要求见 mods-native-engine-original-review-2026-10-04.md。同步 ui.resolve 的独立实际 mount/find/press 13项通过，见 mods-ui-resolve-original-review-2026-10-04.md；真实函数组合、全自身插件组排除、缓存、省略元素fragment及Button动作owner已有原版证据，本工程仍待实现。两项均有可行适配路线，不能当框架限制停止。

## 后续工程落地记录

原生内容组合 v87 已取得受控回归、实际桌面及存量入口的最终证据，完整范围见
[阶段验收](mods-native-engine-stage-2026-10-05.md)。上文“仍待实现”是当时的调查状态，
不覆盖这个后续阶段。跨插件构造器替换仍在实施，方案为
[ui.resolve 接线设计](mods-ui-resolve-design-2026-10-05.md)。原版构造器 SDK 与 callback
另有 11 项和 6 项 qualified 用例；不同研究范围分别计数，不将基础 API 实验当产品验证。
