# StopFailure 失败观察 — 2026-09-23

宿主契约 v54。参考 Claude Code 2.1.278 声明的 StopFailureHookInput；兼容矩阵仍为 partial。

原 main invoke 错误出口提供真实 error、error_details 和可用的部分 last_assistant_message。
分类仍来自本工程 extractErrorDetail，包含 network_error 等桌面类别，不伪装成上游完整枚举。
模型初始化前、无可用部分回答时省略对应事实，不伪造成功回答。

字段通过原 ModsManager / FunctionSession / publication 边界，插件 next 不得改写错误事实。
传统脚本 stdin 同样收到可用字段，保留既有 tool_response。没有新增模型错误处理循环。

开启 Mods 时，错误出口等待原 Hook 调用结束，保留原任务绑定和取消信号，使 guest 的异步
SDK 观察可以在原生命周期内完成。关闭 Mods 时保留传统通知的异步时序。观察异常不取代
原模型错误；返回 block/additionalContext 不能重启任务、批准成功或推进业务状态。

用户主动取消不触发本失败入口，已触发 Stop 时不重复发 StopFailure；这两个既有条件未变。
观察期间取消或撤权会关闭实际模型 HTTP 请求，不接受迟到完成。重启恢复不重放已经失败的
观察；新物理失败重新产生自己的观察。

仍未将该事件接到全部 resume/interrupt/remote 入口，也未统一桌面与上游错误分类。
真实协议测试不等同于真实业务验收。

证据：stop-failure-observer.test.ts、classic-mods.integration.test.ts、classic-session.test.ts、
classic.test.ts、tests/support/mods-stop-failure-e2e.ts；完整日志见同日验证报告。
