# SDK 实际边界与待实现项

参考仍固定为 Claude Code v2.1.278，声明头 2.1.277。本次逐项核对 SDK 声明、生产 `SESSION_CAPABILITIES`、guest 构造器和宿主消费者；[兼容矩阵](mods-v2-compatibility-matrix.json)保留每个成员的状态。源码里出现事件名，或测试能够手动 dispatch，并不能证明 SDK 可调用。

## 已有受限实现

| 成员 | 实际范围与差异 |
| --- | --- |
| `plugin.name/root` | 安装插件的冻结元数据；不是可拦截的 SDK 调用，`engine.create` 不提供它。不能替换宿主授权身份。 |
| `session.id/cwd` | 宿主线程及本次执行目录；并发执行目录各自绑定，项目授权域不会随 guest 输入改变。 |
| `session.messages/model/turns/repo` | 读取实际主会话，冷读走原会话数据；局部消息投影和模型引用属于本应用。Git 查询固定且可取消，remote 去除 URL userinfo。 |
| `session.surface/surfaces/authorize` | 桌面固定值；authorize 为 null。不是动态终端/移动端发现或上游账号授权。 |
| `store.get/set/delete/keys` | SQLite JSON 持久化，按项目与插件隔离；区分未设置与 null，保留插入顺序，受容量/键名限制。不能写宿主验收证据。 |
| `fs.read/list/exists/stat` | 原生权限约束下的项目内读取；读取最多 512 KiB，目录访问最多 1024 项。路径替换检查和发布过滤仍适用。 |
| `command.register/list/run` | 插件命令注册表；不是全部原生命令目录。原调度与 lease 生效，持有 turn 的回调不能等待新的排队命令。 |
| `tool.list/check/call/register` | 当前宿主目录、权限及有界注册 schema；query 不执行或授权。工具参数及名称使用本应用契约，不能用同名宣称 Claude 工具完全一致。 |
| `mcp.call` | 当前连接代际、唯一 provider 和真实审批/回执；不接收 guest 提供的连接与凭据，不自动重试丢失的写响应。 |
| `clock.now/sleep` | now 是 epoch 墙钟；sleep 受本次 dispatch 的取消和预算约束。独立 guest `options.signal` 尚未作为独立取消域传输。runtime 内部 deadline 使用单调时钟。 |
| `ui.resolve/invalidate/open/close` | 受限桌面树及 Pane；invalidate 仅接受 ui.render。不存在任意 DOM、终端 docking 或全部上游选项支持。 |

模型 fork/classify、上下文 breakdown、原生问题/通知/日志、十三个非 Pane 站点和 Client 的边界继续见各自指南及矩阵证据，不能由这张表推导为全面兼容。

## 尚未开放的 SDK

`audio.play/speak`、`prompt.submit/fill/suggest`、`config.list/set`、`agent.spawn/list`、`fs.write/ancestors`、`clock.after/every`、`http.fetch`、`process.run`、`settings.read`、`env.get/set` 尚未进入生产 guest 的 SDK 能力列表。相邻功能不能替代这些接口：例如经审批的 `tool.call(write_file)` 不等同于 `fs.write`，`agent.offer` 或 `model.fork` 也不等同于 `agent.spawn`。

这些是实际未完成项。矩阵中的 partial 不表示已经有可调用的实现；`availability: unavailable` 明确区分“接口待接线”与“已有实现但语义受限”。

## 焦点与滚动：事件不等于主动调用

当前 `ui.focus/ui.scroll` 事件、Pane `autoFocus` 和 Client 输入观察保留原受限适配。新增 **`$.ui.focus()` 的原生桌面 Pane 目标实现**，仍为 partial/bounded；通过真实 renderer 归属探测、原 dispatcher 最终决策和实际 DOM 回执完成，不支持 AbovePrompt、Client 内目标或非桌面 surface。详见[主动焦点说明](mods-v2-imperative-focus-2026-09-24.md)。

回执绕过正在等待 SDK 的回调队列，避免死锁；忙碌 Pane 控件保留焦点但阻止重复操作。关闭、重绘、取消、撤权、重载和竞争输入使旧请求失效。原 composer 和对话框优先。

**`$.ui.scroll()` 已提供受限原生 Pane 实现**：实际几何、原 dispatcher、DOM ACK 与 end 持续跟随；仍不支持 AbovePrompt、Client/Box/Text keys、转录定位。person wheel 观察保留旧像素包。详见[主动滚动说明](mods-v2-imperative-scroll-2026-09-24.md)。

## 证据使用原则

矩阵的 implementation 指向已检视源码，evidence 指向对应测试。源码引用不等于测试通过；可调用性检查只排除不存在的 SDK 名称，也不能证明字段、时序、取消和业务验收全面一致。每次能力升级仍须有真实 guest/session、Electron 以及关闭对照证据，不批量把 partial 升级为 adapted。
