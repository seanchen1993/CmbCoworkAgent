# Client 刷新通知范围

Client 独立更新绘制时，宿主通过原 mods:cards-changed 通道附加 scope: "panes"。FunctionPanes继续刷新，非Pane FunctionSite不再为这个通知查询未变的绘制。它是宿主内部通知，插件没有控制scope的新API，也没有新增授权能力。

缺省scope仍表示原全局通知。显式 $.ui.invalidate("ui.render")、站点动作、配置与旧Mods消息保留原全局行为。原定时合并队列中全局优先：先后顺序不影响结果，Client短帧可以提前通知，但不能把已排队的全局刷新降级。关闭会取消待发通知。

组件本地state改变不自动承诺其它站点重新执行Hook。如果插件修改了影响其它站点的数据，仍应显式调用ui.invalidate；原站点绘制缓存与generation规则保持不变。没有缓存成功授权或跳过结果发布复核。

测试分别覆盖真实QuickJS/FunctionSession、renderer生产订阅函数的窄测以及普通Electron公共IPC/实际Client与提示/命令输出。减少无关查询是已验证的行为；不据此宣称正式TTFT或长稳门禁通过。验证报告见output/mods-v2-validation/2026-09-24-ui-notification.md。
