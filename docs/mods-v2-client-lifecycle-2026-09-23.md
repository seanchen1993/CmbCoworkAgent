# Client 生命周期对齐（2026-09-23）

参考本地 Claude Code v2.1.278 官方 `mods/types/claude-code.d.ts` 中 `ClientSurface`、
`ClientPointerEvent` 契约。该文件 SHA-256 为
`AC107A37C08AD46F8632EDC1639B13A740FAE0B8249A2245532ADFD325E57D0D`。
本批仅调整隔离 surface VM 和 Client 宿主生命周期，不改变 Manager、Session 或 renderer。

## 已实现行为与证据

| 能力 | 状态 | 行为及验证 |
| --- | --- | --- |
| 连续 render → setState 保护 | full | 只统计绘制函数内部调用 setState；无外部事件的第三次连续调用停止实例，错误为 MODS_CLIENT_RENDER_LOOP；释放 surface VM、帧任务及 every 计时器，hooks VM 保持可用。 |
| 外部事件重置计数 | adapted | key、pointer、tick、控件操作、props 更新重置；应用已有 resize、focus、scroll 事件同样视为外部输入。真实 pointer/tick 测试覆盖。 |
| setState 合并 | adapted | 同一调用多次 setState 只安排一个后续宿主帧；保留原有控件事件完成时立即绘制行为。 |
| post 最新值合并 | adapted | 使用主进程 16 ms 帧钟，不是浏览器 requestAnimationFrame。整帧处理完已合并的输入后，只发送一条最新 post；新的 post 在后续帧发送。100 次操作合并为一次 owner hook。 |
| owner 路由及回复 props | full | 仍经过 FunctionSession 的 ui.message，只允许本插件收到；宿主出版过滤后再进入 hook，返回 props 触发后续绘制。 |
| post 数据复制与限制 | partial | 发送时复制纯数据；最多 20,000 个值、100,000 字符（包含键），非法值静默忽略并保留上次合法 post。共享 ModJson 的总深度 32 包含结果包络，所以本实现数据深度最大 30（根深度 0）；官方数据深度上限为 32。28、29、30 层已真实传输验证，31 层及以上忽略。 |
| JSON 宿主安全约束 | adapted | 循环、访问器、函数、非有限数、非普通对象和宿主保留键均不发送；此约束沿用应用安全边界。不得将部分 JSON 支持描述为完整 JsonValue 兼容。 |
| 关闭与取消 | full | 关闭 Pane/Session 时丢弃未发送消息并清空队列；异步过滤完成后重新检查存活状态，关闭后不进入 owner hook。已开始的 owner hook 通过实例 signal 取消，不能随后写状态。 |
| 权限与时序 | adapted | 消息现在在宿主后台帧发送；完成 UI 操作并不表示 ui.message 已完成。后台帧沿用 Session 的独立只读执行作用域，不继承点击的 write lease。 |

错误只停止该 Client。重复清理不会重新发布错误，也不会使已关闭的 Pane 再次出现。
同一 key 的既有状态保留、props 更新、隔离 guest 和 control handle 规则不变。

## 尚未在本批补齐的差异

指针拖拽已有 DOM pointer capture、区域外坐标及 move 帧合并；官方 `fine` 亚单元坐标尚不支持。
当前坐标按 8×24 CSS 像素换算为单元，enter/leave 并未保证使用最后一次 move 坐标；按住中键或
右键的 move 按钮身份也还需专门验证。是否完全禁止拖拽时 transcript 选择/滚动需要独立
renderer/Electron 证据。本批不宣称这些项 full。

Escape 已由 renderer 阻止冒泡、移除 Client 焦点并尝试恢复先前 DOM 焦点；host 和 guest 不把
Escape 交给 surface.onKey。先前焦点元素已卸载时，不保证回到指定 transcript 目标。
本批未增加 drag/Escape 的新生产实现或 Electron 断言。

## 验证

先加入 `client-lifecycle.test.ts` 的失败测试，再实施生产修复。测试运行真实 QuickJS surface
和真实 FunctionSession / ui.message，虚拟时间仅控制宿主帧钟，QuickJS 仍经真实 setImmediate
推进；不是用假 guest 返回预设结果。

最终四套 46/46 通过（2026-09-23 09:27，31.73 秒）：Client 生命周期 18、现有 Client 13、
Pane 9、guest UI 6。Node typecheck 通过，四个改动源码/测试文件 ESLint 零 warning，diff check
通过。260 次 Pane redraw 回收测试也通过。此次 worker 没有运行或宣称 Electron 新能力验收；
由主任务在合并后的快照统一进行 Electron 验证。

记录：`output/mods-v2-validation/2026-09-23-client-lifecycle.md` 及同日
`2026-09-23-client-lifecycle-tests.log`。仅修改 Mods v2 工作树，未改 UAT。
