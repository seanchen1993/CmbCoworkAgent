# 主动 Pane 滚动验证 — 2026-09-24

基线 `4f8061f3` 加本次差异，仅 Mods v2 工作树。当前功能实现已完成本报告所列回归，正式性能门槛仍未通过。没有改变 UAT 或共享依赖。

## 实现范围

`$.ui.scroll` 使用实际 renderer 几何、原 FunctionSession dispatcher 和最终 DOM 确认。只有 offset 可变，origin/位置依据/窗口大小固定。next 不提前移动，后置 deny（含空字符串）保留效力；没有选中 core 或 renderer 拒绝都不能伪造成功。当前支持本插件 Pane 的 start/end 和原生 Button/Input/Select key；end 能随真实内容增长继续滚底，用户离开后停止。CSS line-height 行等价不是终端 cell。AbovePrompt、Client/Box/Text key、transcript reveal 尚未开放，矩阵 partial/bounded；person wheel 保留旧像素包。

宿主随机请求与 Pane/generation 绑定，5 秒总等待，每 Pane 单请求；缺 ACK、挂起 Hook、取消/关闭/重绘/重开/撤权均不返回假成功。ack 使用原线程 IPC 的独立路径，不进入被 SDK 阻塞的 callback 队列。跟随需要宿主 token 与本 renderer 生命周期的本地许可同时存在，不能重载后凭旧 token 自动恢复。

## 失败先行和检视

- 参数/几何先缺模块 red，再 26 green；检视发现 block 数组被 String 强转，新增 red 后改严格 string，27 green。
- exchange 缺模块 red 后两阶段、后置否决、空拒绝、截断、实际拒绝、重入、取消/重绘/关闭和超时 9 green。
- 真实 guest/session 和 pinned input 初次 11 red。新增能力后旧 wheel validator 仍拒绝新输入，再修为按宿主原 envelope 区分，保留原观察语义。相关四文件 41 green，包含原 Pane 9 和 Client 13。
- 真实 Electron 在无 renderer 接线时返回 MODS_UI_SCROLL_TIMEOUT，失败记录 `imperative-scroll-electron-red`。接线后 end/start/key/改写/否决通过；竞争 wheel 触发原重绘代际，真实结果为 MODS_UI_SCROLL_STALE（第 2/3 轮日志保留），测试最初只接受 deny，后改为只允许显式 deny 或这个确定失效错误，并仍检查实际用户位置不被覆盖。
- 持续跟随先 host token 测试 red、真实 Electron 等待 end 跟随增长 red；实现 host token +本地 ResizeObserver 后实际 Electron 第 4 轮 8 checks 全部通过。截图已检视，实际内容增长、真实滚轮停止、DOM 位置/焦点、重载、撤权/off 和无新增模型请求均保留断言。
- 最后检视发现 ACK 等待期间的用户移动可能被迟到响应重新启用跟随。提取原“先 await 再 prepare”顺序，回归真实失败（700 被拉回 900），改为先准备本地许可、ACK 只确认，用户操作可在等待中取消；旧 ACK 拒绝只删除同 id 许可，不影响更新请求。两个确定性 DOM 状态测试通过，**它们不是实际 Electron DOM 验收**；后续完整 Electron 使用最终代码。

## 已知验证结果

5 文件 68 项窄测通过（geometry27、exchange9、real session4、pinned16、focus12），另 renderer 竞态 2 项通过。最终 Node/Web tsc exit0；E2E helper tsc0。scoped ESLint 零错误、74 项旧跨域文件格式警告，新模块/renderer/helper零警告。git diff --check 通过。host revision 为 desktop-scroll-ack-v56，新摘要需重新授权。

## 最终回归与回检

- 冻结 Mods43（含 renderer race 文件）：135 文件、1195 项测试全部通过，exit 0；日志 2026-09-24-mods43.log。
- 冻结完整 Electron `2026-09-24-scroll-full-electron.log`：180 检查全部通过，runner exit 0、普通 out 已恢复；artifact 同前缀 -artifacts。原 native read off 对照 p95 3.2666→3.2197ms（-1.4357%，各 500 次、100 warmup），不是正式独占性能门槛。
- 独占性能 smoke/关闭对照结束，exit 0 只表示场景执行完毕；qualified=false / passed=false。目录 `desktop-performance-2026-09-23T22-35-24-597Z-smoke-ecdb9d82/`。off/on 各 2 样本，TTFT p95 112.9/164.3ms（+51.4ms），吞吐比 0.995207；各约1秒 idle 增量 1.145402 单核百分点。没有其他测试/build/E2E 重叠；短样本不构成正式性能通过，也不证明相对前次 smoke 的改善具有统计意义。
- 兼容文档和矩阵已更新，仍 partial；随本次独立能力提交，不能算全部 Mods v2 已完成。

原正式 TTFT +67.7ms 和 ingress 关闭对照超预算仍未通过；2h/10000 事件 soak、Actions 安装验证尚未完成。真实业务 demo 单独使用原报告，当前 UI 契约测试不替代真实业务验收。
