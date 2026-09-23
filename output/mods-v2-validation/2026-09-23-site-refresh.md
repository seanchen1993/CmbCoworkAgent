# 多位置刷新回归修复

基线 `bf109779`。综合Electron12在已有focus-board输入后失败，多个位置出现绘制失败。
实际日志包含32挂载并发容量拒绝、runtime lost及过期owner；不是把测试超时直接放宽。

宿主驱动的site首次绘制原本通过内部Pane广播全局变更。许多历史消息/命令同时挂载时，
每个广播作废其他未完成请求，挂载取消/重建再广播，导致反馈放大。新增20个owner回归先
失败，确认正常挂载/绘制不应广播全局。现在仅实际用户动作和SDK invalidate通知刷新；
保留原Pane的通知、焦点和取消语义。renderer展示IPC最多4个在途、256个等待；过期排队
请求不调用宿主，晚到owner仍返回给renderer显式释放，不泄漏或自动取得新的动作权限。

- 窄测55通过（含正在实现的工具site）；修复独立暂存树 `a851e236` 导出到
  `site-queue-index-review`，去掉未提交工具site后42测通过，Node/Web类型检查通过。
- ESLint通过；独立检视确认未改动工具、权限和模型队列，只有展示IPC使用此限流。
- 综合Electron13全部89场景通过，约313秒；旧焦点、真实Input、模型/MCP、队列、后台、
  完成修复循环、证据、compaction、status/messages/Svg/command output、关闭对照均通过。
  新ToolUse/ToolResult的专用场景未在此快照加载，另行验证，不包含在89项声明中。
- 性能回检：100个排队请求峰值4，取消请求零宿主调用；260个已接收请求在超限后仍完成，
  没有为通过测试放宽进程预算。整应用正式性能门槛仍待专用资格运行。

日志：`2026-09-23-site-notification-red-2/green.log`、`2026-09-23-site-queue-*`、
`2026-09-23-electron-integrated-12/13.log`；实际截图与记录 `2026-09-23-electron-13-artifacts/`。
