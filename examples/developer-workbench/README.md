# 开发工作台

一个普通灵件，通过公开 SDK 组合原生能力；没有 Electron IPC、平台 runner、终端、模型调用或业务项目依赖。

## 普通用户入口

1. 在灵件示例目录选择“开发工作台”，安装后在当前聊天核对来源、集中授权并应用。原文件和进程策略仍会要求审批或拒绝。
2. 从扩展页面、导航、侧栏、工具栏或设置打开“开发工作台”。这些是五个真实 surface placement；目前宿主可能把部分入口集中显示在同一按钮区，不代表五个独立停靠窗口。
3. 也可在原命令入口选择 `/dev-workbench` 或 `/dev-workbench-settings`。没有全局快捷键；保留宿主发送、保存与审批快捷键。
4. 在“工作台设置”保存 argv JSON、工作区相对源码路径及从 1 开始的行列。保存后从同一 store 读回；不执行命令。默认 argv 是 `["node","--version"]`，没有目录扫描、环境变量、shell 拼接或依赖安装。
5. 点击“读取能力与原生状态”分别查看 Java 服务、文件观察、工作流等真实状态。能力来源可用不表示 Java 已启动；排障时可点击“查看开发信息”展开有界详情，省略与截断均明确标记，再点击“收起开发信息”恢复简洁显示。Java 观察不可用时，去原“自定义设置 → Java 代码诊断”配置并启动，然后手动刷新。灵件不会安装或启动语言服务。
6. 显式点击 Java 诊断或源码定位。诊断是缓存观察，版本可能未知；源码预览是安全纯文本，只有 30 秒握手期限内的实际定位 ACK 才算加载。已加载的是非实时文件快照，可继续阅读；关闭、切换、撤权或运行时结束会使其失效。外部 IDE 只能在原生预览中明确点击，并重新核对来源、权限与文件字节；回执仅代表启动请求，不能确认外窗已显示，不支持的路径仍可内置预览。
7. 点击“订阅工作区变更”连接原观察服务；提示可以合并、失效或要求重同步，不是逐文件内容证明。关闭观察或页面会清理订阅与计时器。原观察服务未就绪时会明确不可用；不代替它扫描仓库。
8. 点击“确认仓库并读取 HEAD 差异清单”，沿原生确认绑定当前工作区，再读取最多八项；不修改 Git。Git、workflow 的公开状态也可从刷新结果发现，观察不等于授权启动流程。
9. 点击“启动已保存的检查”后，仍走原 `process.spawn` 策略。核对实际输出、退出码、关闭回执；可点“请求取消”。默认只查看 Node 版本，可换成自己的明确 argv。不要把不可信文本直接填入执行参数。
10. “核对原生通知”只在明确点击时发出通知。停用/撤权后宿主撤销界面与资源；重新加载只展示历史未知记录，不重放任务。

## 可复用协议与真实边界

本包同时提供 `developer-workbench/tasks/1.0.0` 和消费 UI。其他灵件可以通过公开 `platform.read/subscribe/poll` 读取 `{tasks}`，通过明确动作 `start({taskId,argv})`、`cancel({taskId})` 组合它；与已有 task-workbench 示例相同的公共任务形状，不依赖平台私有 runner。任务最多四项，输出仅保存尾部 512 字符。

- `scheduled`、`awaiting-sdk-process` 不证明进程已启动。首个真实输出给出 `sdk-output-observed`；自然结果给出 `sdk-result-observed`。
- `closed-with-result`、`exitObserved/code/signal` 来自自然 SDK 结果，不从 stdout 中的 PASS/FAIL 推断成功。退出码 0 也只说明本次所选命令的退出结果。
- `cancel-requested` 只是请求。SDK `return()` 完成后才记 `closeConfirmed/closed-after-cancel`，它的种子返回值不作退出证据。调度前取消为 `cancelled-before-start`；错误或结果不明为 `unknown`，不自动重试。
- 历史快照标为 `historical-unknown`；即使保留旧的退出字段，也不证明本次连接或当前源码已通过。没有存储 PID、审批票据或原生授权。
- `native.code/java/1.0.0` 有十个公开方法；本示例仅演示最小 diagnostics。定义/引用等可由作者按同样来源与路径策略扩展。
- `native.editor/navigation/1.0.0` 仅发安全预览意图；`native.workspace/changes/1.0.0` 只读订阅；`native.git/inspection/1.0.0` 明确绑定后只读；`native.workflow/runs/1.0.0` 只展示原生状态。发现不存在的来源不会假装可用。

UI 使用普通 Box/Button/Form/Text，可自行组合布局；不引入 dock 引擎、PTY 或全局键盘拦截。示例不是完整 IDE，不替代原项目、Feature 或审批流程。

## 验证与打包

源码检查和真实 Guest 微链位于 `src/main/mods/v2/developer-workbench-example.test.ts`：作者类型/SDK 审计、原生能力的明确按钮分派（测试 facade）、真实短 Node 进程和取消、持久化、订阅释放。测试 facade 分派不等于真实桌面 Java/IDE 已验收。

安装 ZIP 的根目录直接包含本文件、plugin.json 与 hooks/；示例目录绑定全部文件 SHA-256，修改任一文件必须同步精确目录清单。打包示例无需构建生产应用。
