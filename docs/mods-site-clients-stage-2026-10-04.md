# 聊天各位置运行交互组件：阶段18验证账本

持续目标仍进行中。本阶段源码在 `C:\ai\CmbCoworkAgent-mods-v2` 的 `codex/mods-v2`，UAT只读。阶段18已完成；整体兼容继续迭代，不在此阶段停止。

## 用户会看到什么

已安装并批准的交互组件可以直接出现在输入框上方、消息、工具记录和问答说明区。作者使用同一个 Client 模块，用户沿用安装、选择和批准操作；不再只能把它放进独立面板。相同组件放在不同位置，各自保留独立状态。

父画面重画保留组件状态和已接受的主模块回复。旧画面的点击、尚未交付的消息和迟到回复都不能借新的画面继续生效。问答组件只补充说明：真实回答仍由原问题选项、文字输入和“提交”完成。

## 依据与真实范围

固定 Claude Code 2.1.289 的完整发布包验证、声明摘要和实际隔离原版测试见 `mods-latest-289-audit-2026-10-04.md`。原版十三个非 Pane 位置的加载、绘制、运行错误和异步成功共52项通过；不能称为原版真实桌面绘制测试。

本阶段支持 AbovePrompt、PromptHint、InfoNotice、Spinner、TurnDuration、SessionMode、UserMessage、AssistantMessage、CommandOutput、ToolUse、ToolResult、ToolGroup、AskUserQuestion。所有位置与 Pane 共用同一实际 Session 的八个活动 Client 上限，保留现有批准、保护、VM与后台只读入口。

仍未补官方完整 engine 节点嵌套或 ui.resolve 构造器替换；原生问答沿用 DevClaw 实际说明区和原控件。终端、官方移动端和像素绘制仍没有对应产品入口。整体兼容不能写成 full parity。

## 检视发现与修复前证据

- `mods-site-clients-red.log`：实际 site 拒绝 Client 的六个失败反例。
- `mods-site-clients-notification-red.log`：初次 open 的全局通知吞掉随后局部错误备用重画，已改为在合并入口抑制宿主驱动通知。
- `mods-site-clients-old-action-red.log`：旧画面首次到达的点击能命中新 VM 保留的 handle，已为原生 snapshot/action固定 generation，并更新真实 React 回调依赖。
- `mods-site-clients-queued-post-red.log`：未交付 post 借已经采用的新父代际执行，已固定消息与后台事件来源并清掉旧队列。
- `mods-site-clients-pending-parent-red.log`：新父渲染仍在等待时，旧 post 确实进入了真实 message、模型和文件调用。私有回执现在拒绝 pendingGeneration，旧队列被当作原生失效而非组件错误。
- `mods-site-clients-old-reply-red.log`：旧控制失败会给同实例新画面写错误。回复和刷新现在核对线程、位置、实例和代际，等待计数仍按各自操作归还。
- `mods-site-clients-ipc-scope-red.log`：真正 main/preload 转运丢掉 site 范围，发成全局事件。生产转运改为完整保留已定义范围；真实表达式回归和 Electron 实收再次通过。发现后中止的广域保留为 incomplete-before-ipc-fix，不计为最终结果。

真实主模块控制和 message Hook 在 SDK 等待后父换代，模型、文件、界面与保存均零效果；新画面同操作正向各成功一次。原版依据、真实 QuickJS、控制桥的 React 和真实 Electron分别记录，不混用证据等级。

## 最终验证

两位独立最终静态检视通过；追加 IPC 漏点修复后，两位再次确认完整转运链，原检查结论被修订后的结论替代。

| 验证 | 结果与范围 | 日志 |
| --- | --- | --- |
| 冻结受控回归 | 382 文件、3348 项通过，420.42 秒；覆盖 Mods 与旧聊天、Plugin、项目、Harness、IM、Goal 等邻近范围 | output/mods-site-clients-controlled-broad.log |
| 实际 main/preload 与核心 | 3 文件31项通过，含29个真实 QuickJS 交互/生命周期案例和真实转运表达式 | output/mods-site-clients-ipc-scope-green.log |
| 真实 React | 8 场景通过；控制桥夹具，包含其它位置30帧零查询、旧回复、新代际可点击和原生问答 | output/mods-site-clients-browser-final-verified.log |
| 原 Flow 与 Claw | 20 与2场景通过 | output/mods-site-clients-existing-flow-browser.log、output/mods-site-clients-existing-claw-browser.log |
| 原桌面交互 | 21 场景通过 | output/mods-site-clients-existing-desktop-browser.log |
| 真实 Electron | site-clients 8、client-fault 8、hold-toasts 6、continuity 8，共30检查点；含4次共同开关检查，不冒称30种独立功能 | output/mods-site-clients-electron-final-verified.log |
| Node/Web 类型 | 通过；新增测试空数组的类型标注错误已修正 | output/mods-site-clients-types-final-confirmed.log |
| 本阶段 lint | 36文件，0错误、802存量/现有警告；不称全仓 lint 无债务 | output/mods-site-clients-final-lint.log |
| 兼容声明 | 22项通过；上一阶段提示暂存条目缺少范围和证据造成2项文档检查失败，补全后复测及整轮广域通过 | output/mods-site-clients-matrix-final.log |

Electron 实际验证安装批准、输入框上方点击、局部通知范围、父重画保留状态、正常原生问答、一次错误备用画面和撤权。撤权后原输入框真正发送一轮模型任务并收到回答，不能只以还能打字作为通过。交互组件操作阶段没有模型请求；普通聊天正向阶段明确有真实本地 HTTP 请求。证据目录 output/mods-validation/e2e-site-clients。

初次 Electron 夹具修正包括命令参数的写法与斜杠菜单需要完成选择；前两次失败不足以单独证明命令注册是原因。第三次需等新组件真正绘制再点失败按钮，旧画面被拒绝不等于新组件自身故障。所有早期失败日志保留。正式结果来自最终修正后的运行；普通构建已恢复，out/main/mods-e2e.js 不存在。

## 隔离性能与继续范围

独立执行真实本地 QuickJS 异步 Client 控制、绘制、保护和 site 快照，预热5次、采样30次，中位1.4984ms、95分位1.8065ms；父 ui.render 实际只执行一次。日志 output/mods-site-clients-performance-final.log，数据 output/mods-site-clients-performance.json。这不包含 utility IPC、DOM、系统绘制或模型延迟，不能称为完整端到端时延。

示例用法见 mods-v2-authoring.md 的“在聊天里直接放自己的交互组件”。阶段19继续 mods-plugin-prompt-design-2026-10-04.md，依据新的原版探针补主动提交队列、真实启动回执和持久插件来源。完整原生 engine 与构造器替换、消息追加等仍未完成；尚无新的框架限制证据，持续目标保持进行中。
