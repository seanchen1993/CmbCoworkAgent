# 组件出错恢复：阶段15验证记录

本阶段让桌面 Pane 里的实际组件出错后能通知作者，并自动重画一次备用内容；异步点击能正常完成。整体对齐继续进行，不把这一阶段说成全部完成。

## 已交付效果

加载、绘制、点击分别按真实步骤报告 load/render/run。只通知所属模组，错误文字经过原内容保护、单行和 200 字上限，所有身份和阶段由宿主固定。先停止坏组件，再独立通知和恢复，避免面板等待自己的重画。恢复过程中刚创建的组件再坏只通知，不循环重画；原来正常的组件保留状态，同 key/module 已停止实例不会被普通父刷新复活。

临时宿主容量拒绝不是组件故障。恢复时只补重画，不重放已完成的点击；点击发出的数据、处理链返回的新 props 都保留，并验证实际只交付一次。取消、撤权、关闭或替换后，迟到通知不能写入状态、关闭新面板或恢复旧组件。内容保护拒绝错误文字后，不继续自动重画。

宿主版本为 module-resources-v82。其他绘制位置的 Client 还没有实际宿主，本阶段仅覆盖 Pane，不宣称所有官方位置已对齐。

## 原版及实现检视

完整官方 2.1.289 来源与 hash 见 mods-latest-289-audit-2026-10-04.md。实际原版 plugin test 十项最终再次通过，日志 output/mods-289-fault-final-probe.log；测试使用正确必需参数 ui.invalidate("ui.render")。只能证明原版隔离测试语义，不能冒称真正官方桌面或模型已测。

两位独立最终静态复审通过。复审发现并修正错误通知保护拒绝仍重画、旧通知的 SDK 越界、点击成功后绘制被拒绝丢 post、纯重画覆盖已接受 props。每项有实际 QuickJS 失败与修复后成功证据；最后一项红日志 output/mods-client-message-props-red.log。测试安装 API、等待旧备用内容和遗漏 invalidate 参数导致的早期 Electron 失败是夹具问题，日志保留，不能冒称生产错误或最终通过。

## 当前验证账本

- 最终邻近回归：7 文件 124 项通过，output/mods-client-fault-final-qualified-narrow.log；其中新 Client 实际 VM 场景 30 项，含容量、伪造错误码、保护、故障链、异步点击、迟到动作及一次 post。
- Node/Web 类型通过，output/mods-client-fault-final-types.log。
- 本阶段 21 文件 lint：0 错误，760 个已有样式警告，output/mods-client-fault-final-lint.json；不宣称全仓 lint 无债务。
- 最终实际 Electron：client-fault 8、client-focus 9、client-busy 4、continuity 8，共 29 检查点通过，output/mods-client-fault-final-electron.log。真实安装批准、utility process、备用显示、异步点击、一次恢复、撤权、焦点与忙碌、原聊天链都有实际界面检查。截图与 evidence 在 output/mods-validation/e2e-client-fault；普通构建已经恢复，out/main/mods-e2e.js 不存在。
- 冻结受控广域 374 文件、3223 项通过（413.81 秒）。结果日志 output/mods-client-fault-controlled-broad.log；完整 npm test 原有失败不在本阶段作无依据的绿色声明。
- 实际本地 VM listener+draw 性能文件 output/mods-client-fault-performance.json，每种 24 次剔除前 4 次。本地 QuickJS 范围不含 utility IPC、界面绘制、网络或模型；数据同时写入兼容矩阵，不能保证整应用延迟。

## 作者用法

on("ui.fault", ($, e, next) => { /* 记录失败，下一次 ui.render 显示备用内容 */ return next(e) })。完整例子已加入 mods-v2-authoring.md 的“组件出错时显示备用内容”。不需要用户点击重试；作者要重建真正的新实例时应使用新 key 或明确重载。

接下来继续链接降级、面板停驻通知和消息输入等尚可适配的能力。未得到新的框架限制证据，目标继续进行中。
