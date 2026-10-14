# 面板阅读期间暂存提示：阶段17完成记录

本阶段在 codex/mods-v2 完成，UAT 未修改，宿主 module-resources-v84。整体对齐继续，下一步是聊天其它位置的 Client，不在这里结束。

## 用户现在能感受到什么

组件打开阅读面板时设置 holdToasts:true，当前会话的组件短提示和聊天核心短提示会等待。关闭面板、收起侧栏，或再次打开时省略这一设置，才显示积存提示；从真正显示开始计时。鼠标停留或窗口隐藏会暂停，返回继续剩余时间。点击提示任意正文可以关闭。状态、问题说明、批准控件和原聊天仍可使用。

用户仍按原方式安装、选择、批准和在对话中运行组件，不增加一个新开关。作者的可运行写法见 mods-v2-authoring.md。本阶段没有把其它窗口、无真实会话来源的全局通知或持久错误都当作可隐藏短提示。

## 基础与检视

显示报告绑定原生窗口所有者、实际 Session、保护后的已发布条目、回执与序号，不允许改变文字、时长或执行权限。新条目在创建时不计时，采用私有单调时钟；后台读取不创建运行实例。实际视口和滚动裁剪参与可见性判断，独立 Sonner 通过 body Portal 保持原位置及主题。它在 owner 启用时保持轻量挂载，空时没有提示卡片；实测 Sonner 不回放挂载前发出的第一条事件。

两位独立方案和最终静态检视通过。检视补齐了隐藏后动画帧停止、旧回执取消丢失、保护失败/配置重绑复活取消提示、第一帧抢跑、同 ID 路由交接、容量移除后重发、批量取消误放继任、原生 action/cancel 阻塞，以及只读聊天丢失状态。取消标记只在成功保护快照确认 ID 消失后清理，或在真正卸载时释放。

修复前证据保留在 output/mods-hold-toasts-red.log、engine-review-red.log、entry-red.log、final-boundary-red.log、geometry-red.log、receipt-race-red.log、publication-failure-red.log。原生 Electron 初轮的撤权状态假设和最终根 button 查找错误属于测试夹具错误；按原整实例退休与实际可访问按钮修正，最终真实运行通过。

## 实际验证

| 验证 | 结果 | 记录 |
| --- | --- | --- |
| 冻结广域回归 | 380 文件、3317 项通过，419.89 秒 | output/mods-hold-toasts-controlled-broad.log；同名 scope.txt |
| 相邻与边界 | 9 文件 172 项；最终新增 engine/publisher 33 项通过，均纳入冻结广域 | output/mods-hold-toasts-final-adjacent.log；final-boundary-green.log |
| 实际 React/Sonner | 16 场景通过，含固定定位、无动画帧隐藏、取消竞争和只读状态 | output/mods-hold-toasts-browser-final.log；mods-hold-toasts-browser/report.json |
| 原 Flow/Claw | 完整原脚本 20 场景通过 | output/mods-hold-toasts-existing-flow-browser.log |
| 原桌面交互 | 21 场景通过 | output/mods-hold-toasts-existing-desktop-browser.log |
| 实际 Electron | hold 6、原反馈 4、连续任务 8，共18检查点通过；普通构建恢复 | output/mods-hold-toasts-electron-final-verified.log |
| 类型与 lint | Node/Web 通过；34文件 lint 0错误、2249条已有格式等警告 | output/mods-hold-toasts-final-types.log；final-lint.log/json |

实际 Electron 安装批准两个模组，提示暂存1774ms后才显示，观察到1313ms显示时间；实际 BrowserWindow.hide/show 暂停超过超时仍保留同一条提示。真实“设为 Goal”触发的核心提示也实际释放并到期，未增加模型调用或把提示写入对话。具体数据与截图见 output/mods-validation/e2e-hold-toasts/hold-evidence.json、notifications-held.png、notifications-released.png。

35次本地采样，前5次预热，30次统计：32条宿主提示、21次报告的中位0.652ms，95分位1.007ms；40条引擎队列、20次状态变化中位0.305ms，95分位0.482ms。验证处理和定时资源有界，不包含 guest、IPC、DOM、模型或系统绘制，不能当成界面总体延迟。记录 output/mods-hold-toasts-performance.json/log。

广域保留原 Plugin、项目、Harness、IM、Goal、Flow/Claw 相邻覆盖；不宣称全工程历史失败消失。此前全量基线有 JetBrains、Chrome 和主题等11项失败，本阶段受控范围明确单列。

## 与官方的差距

依据固定289声明中 holdToasts、toast显示计时与状态保留的契约；原版 plugin test没有验证官方真实桌面提示计时的入口，本阶段不把我们的测试当作官方界面运行结果。当前覆盖 Pane 和本会话 ChatContainer 的有限短提示调用，其它产品入口需逐项适配。DOM 布局与原生窗口隐藏确认不证明 OS 每一帧绘制。其它绘制位置的 Client、插件主动提交与消息追加仍可继续实现，没有新增框架限制结论。
