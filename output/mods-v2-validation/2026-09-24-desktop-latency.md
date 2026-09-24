# 长稳原生事件测量与失败证据 — 2026-09-24

基线 dc30e72e。仅测试驱动变更，应用仍为 guest-codegen-boundary-v63；不改原 Client busy/权限/租约/完成循环，不改变超时或重试真实点击。

## 先失败再修复

新 Electron DOM 回归首先遇到当前页面尚未载入 tsx __name init helper 的测试准备问题（desktop-latency-red.log）。专用入口 reload 后，旧探针在按钮替换、实际 ACK 已出现的情况下仍 timeout 5000（desktop-latency-red2.log），才是本次有效失败测试。

探针改为识别同一 Pane 当前的目标按钮，记录可信 input、pointerdown/up、click 的最后16项，保留 Client instance、handle、原按钮身份/连接、disabled/aria-disabled/focus。字符串长度受限，只采集限定格式的 ACK，不采集输入值或会话内容。重复点击清除旧时间，清理监听/RAF/observer；缺少确认绝不补造 PASS。soak 失败时另写 desktop-soak-failure.json，renderer 已退出则明确 unavailable。

## 验证与边界

- 专项普通 Electron：5项通过（含全局默认关闭）；覆盖真实可信点击、替换节点、合成事件不计入、缺 ACK、16项上限、禁用状态与清理。DOM fixture 只验证探针，不是 guest 或业务验收。
- helper TypeScript、Node/Web typecheck、4文件差量 ESLint 通过；根 E2E 的既有88 warnings未新增/未修改。
- 新普通构建和真实插件/session：desktop-soak-2026-09-24T06-21-23-772Z-smoke-3891d8be，8个批准插件、4个真实Client、24次确认、3次关闭/重载。input→第二帧p95 10.9ms，click→host ACK p95 265ms；qualified=false，未做内存合格声明。
- 50条命令历史 + 200 次 Client 确认回归：4项通过，重载/关闭后状态正确（desktop-latency-history.log，进程32241 exit0）。
- 应用生产源码与已完成完整 Electron223 / Mods58 1333 / utility44 的精确v63基线相同，本次不将复用基线描述为新跑全量。

原正式长稳事件6408失败于实际 ACK 等待、SQLite也未推进，与本次旧探针测量超时不同。真实丢失确认根因仍未证明，2小时/10000事件仍须正式重跑。正式TTFT及关闭性能门禁也没有由本次短测转绿。

代码检视：只修改测试路径；目标限同Pane；不放开生产UI忙状态；可信事件且有界；不读任意DOM内容；失败仍抛原错误；禁止用synthetic click补齐事件。UAT/共享依赖/本地NSIS未动。
