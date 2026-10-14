# V5 兼容增量与明确边界

本轮代码目录是已有事件目录加经过本轮核对的新增项，不是 Claude Code 2.1.283 所有公开声明的完整清单。没有逐条记录、生产触发和参考运行时证据的项目，不计为已完整兼容。

新增 `session.send`、`process.spawn`、`session.version`、`session.root` 的已知未实现诊断。未知自定义事件继续标记需要提供者或尚未验证，不能用注册成功推断会触发。检查结论只涵盖注册事件的生产适配器，不涵盖任意 SDK 调用、动态属性访问、权限、匹配器业务条件及运行结果。

URL 与 URLSearchParams 使用固定 WHATWG 实现，在原 QuickJS 内惰性初始化，保留 50ms 执行片和 16MiB 内存边界。未使用 URL 的插件不解析整套库。生成脚本按 esbuild 实际输入文件解析依赖包版本与许可证，`--check` 校验生成产物一致性，避免从顶层同名包误取嵌套依赖的许可证。

实际依赖为 whatwg-url 14.2.0、tr46 5.1.1、webidl-conversions 7.0.0、punycode 2.3.1。完整许可证见 `src/main/mods/v2/guest-url-LICENSE.txt`。

已知差异：原始 whatwg-url 14.2.0 对 `https://1א.example` 的 IDNA 双向文本标签校验返回 TypeError，Node 22/24 标准 URL 接受并转换为 `xn--1-0hc.example`。本轮保留库行为并设置明确回归，不把 Node 差分通过描述成与 Claude 的所有边界等价。Blob/object URL 没有对应宿主，未提供 createObjectURL/revokeObjectURL。

完整回归、E2E 与性能验收结果由本轮交付报告记录；这份增量说明不宣称资源 SDK、消息投递、完整类型工具或所有界面与事件已完成。
