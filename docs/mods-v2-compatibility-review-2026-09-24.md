# Claude Mods 兼容边界复核

> 下文保留 `7ae3c6ab` 的历史审查。后续已核对 [v2.1.280 官方参考](mods-v2-claude-reference-2026-09-24.md)，并实现有界 [atob/btoa](mods-v2-base64-2026-09-24.md)。当前矩阵为 49 adapted、155 partial、41 unsupported、0 full；当前能力、Actions 结果及未通过门禁以[实施状态](mods-v2-status-2026-09-24.md)为准。

基线7ae3c6ab，固定参考Claude Code v2.1.278（声明头2.1.277）。完整逐项表为[兼容矩阵](mods-v2-compatibility-matrix.json)。本轮审查文档及新增边界测试，没有修改应用运行时代码。

矩阵共245条声明：49 adapted、153 partial、43 unsupported、0 full。96条缺少范围说明的计划占位已逐项复核；另15条已有缺口说明的classic记录改为schema-only标签，状态仍partial，没有把它们标成已接入生产。所有声明都有实际范围说明；这不等于全部能力实现或发布门禁通过。

| 范围 | 当前实际边界 |
| --- | --- |
| Engine与SDK同名 | SDK.ui.resolve是当前绘制范围的本地构造器，engine ui.resolve尚无生产元素表改写阶段；不能凭同名视为同一能力。 |
| 控件动作 | Pane与Client控件均经原宿主控制Hook和owner/handle校验，Client随后进入隔离回调；事件字段沿用本应用的Pane envelope。 |
| Session读取 | 真实操作分发及宿主数据投影；插件改写的返回值不能改变原workspace/thread/lease权限。 |
| 文件和存储 | 受控项目文件边界与独立插件JSON存储；非任意文件系统、非宿主验证证据写入口。 |
| Client | 独立VM、当前实例状态、有界计时器/事件/JSON消息；非浏览器环境、嵌套Client或重启持久化状态。 |
| 全局对象 | h/Fragment真实可用；JSX是类型/编译元数据。AbortSignal/AbortController/TextEncoder/TextDecoder/URLSearchParams/URL/atob/btoa/structuredClone/crypto/performance在hooks及Client均未提供。 |
| 缺失SDK | audio、http、process、settings、env、fs.ancestors、clock.after/every等没有相应内建SDK操作；原生工具和Client.every不是替代兼容证据。 |
| classic缺口 | PermissionRequest/Denied、Pre/PostModelSwitch、TaskCreated/Completed、Elicitation/Result、ConfigChange、WorktreeCreate/Remove、CwdChanged、FileChanged、DirectoryAdded、MessageDisplay只有schema/手动分发，无生产触发或结果效果闭环。 |
| 测试与包 | 本应用没有完整上游测试引擎API；源码/普通Electron验证不替代GitHub Actions产物和安装后验收。 |

本轮新增条目的availability含义：bounded表示可用子集及明确限制；metadata表示只具备类型、编译或schema层面能力；unavailable表示未提供相应内建SDK、全局或生产触发器。unsupported不是通过验收的功能，也没有通过命名或文档改写“补上”功能。

测试区分两件事：真实guest、Client和utility进程验证对象是否实际存在；既有语义测试及Electron场景验证对应已实现子集。只有前者不能证明完整行为兼容。未实现的engine事件依据生产调用点审查明确缺口，没有拿手动dispatch当真实业务触发。

完整v63 Electron223和性能结果见[代码生成边界报告](../output/mods-v2-validation/2026-09-24-guest-codegen.md)。正式TTFT、ingress关闭、两小时长稳与Actions安装门禁仍未完成；真实Autobiz任务演示的通过范围仍以其独立报告为准。
