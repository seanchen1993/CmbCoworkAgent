# 后台任务读取的单调期限验证 — 2026-09-24

基线 `eb613005`；仅 Mods v2 工作树。生产改动仅 `readBackgroundTask` 的耗时、剩余时间与轮询间隔使用 `performance.now()`，不改变 epoch 时间戳、原生 LocalSandbox API、审批、grant、runtime authority、generation、lease 或取消逻辑。

## 先失败，再实现

- 真实 QuickJS / FunctionSession / ModsManager / SQLite / LocalSandbox 后台进程测试：冻结和逐次回拨 Date.now，两项均被 700ms 取消护栏中止，未按配置 200ms 返回。原始 red 日志 `2026-09-24-background-timeout-red.log`。
- Electron 原普通构建，原 Agent 先执行真实 read 建立 runtime，再由人提交非 immediate 插件命令，以原生审批启动 5 秒真实进程。在隔离测试 Electron main 内冻结 Date.now 1200ms（不改操作系统时钟），SDK 读取超时为 200ms。red4 实测从故障注入到回执 **1444.011ms**，超过 1000ms 上界。
- 初始 Electron fixture 尝试冷命令被 `MODS_BACKGROUND_OWNER_REQUIRED` 拒绝；尝试在自动 tool.call hook 内启动进程被 `MODS_WRITE_REQUIRES_USER_ACTION` 拒绝。这两项是保留的边界，不作为本次超时 bug。第三轮因 tsx 的 __name 跨 realm 引用失败；改为对象方法后 red4 才是有效产品红测。
- 新实现专项 Electron **3 checks PASS**，200ms 读取在注入后 **692.414ms** 返回 completed:false / retrieval_status:timeout（含命令预留的 500ms 交接等待）。一个真实 native approval，预热两个本地 HTTP fixture 模型请求；不是外部业务验收。
- 关闭 Mods 后同线程原模型/native read 再次完成，原文件内容保留，没有新增插件工具审计回执。截图已实际检查。

## 检视与验证

- 四文件 **88 tests PASS**：真实后台输出、取消、撤权、session close、runtime replacement、lease release/handoff、managed foreground、关闭模块原生后台任务。两项墙钟故障均通过，finally 恢复 spy/取消 timer。
- Node / Web TypeScript、E2E helper TypeScript、scoped ESLint 均 exit0，专项 lint 无 warning；普通生产 build exit0。
- 最终 Mods44 **135 files / 1197 PASS**，包括 renderer scroll race 测试；exit0 已确认。完整 Electron **182 checks PASS**，exit0、普通 out 恢复；本能力在整套中从注入到回执 **704.780ms**。原 native read 关闭对照 p95 4.2881→3.4691ms（并行单测期间的功能回检，不是独占正式门槛）。独占性能 smoke 已结束，exit0 仅表示执行完毕，qualified=false / passed=false。目录 `desktop-performance-2026-09-23T23-03-25-056Z-smoke-5a2ad4a6/`；off/on 各 2 样本，TTFT p95 110.6/163.5ms（+52.9ms），吞吐比 0.9952867；约 1 秒 idle 增量 1.552334 单核百分点。未与任何其他测试/build/E2E 重叠。小样本不作为正式性能通过，也不推断相对上次 smoke 有统计显著变化。
- 函数每次轮询仍复核 signal 与 live authority；已完成结果/非阻塞读取/零超时分支顺序保留。只保证轮询等待期限，不把后台进程执行超时混为一谈。

## 尚未完成的总门禁

此前正式 desktop full4 TTFT 增量 +67.7ms 仍失败；正式 ingress 关闭对照有 1/10 组超预算。实际两小时 / 10000 事件 soak、剩余兼容能力和 GitHub Actions 安装交付仍需继续。未修改 UAT、共享依赖，未进行本机 NSIS 打包。
