# 桌面测量统一单调时钟：2026-09-24

正式desktop-performance full2（desktop-performance-2026-09-23T16-14-24-252Z-full-1edea0de）
结束exit1。off等待使用Date.now而elapsed用performance.now，off实际仅298264.5793ms，on300005.1108ms；
未满足两个300000ms窗口，qualified=false。只证明时钟测量不一致，不能断言系统校时原因。
100个流式测量样本/110个真实请求已执行；off/on TTFT p95 748.2/927.4ms，增量179.2ms超过40ms，
throughputratio .9951706095。CPU点1.7792873738/1.8330331058（增量.053745732）不改变本轮不合格结论。

先增加失败测试（缺helper），再实现waitUntilMonotonic：用performance.now控制等待、间隔、时长和资格计算，
每次等待最多500ms并复核STOP；仅startedAt使用墙钟作展示。没有降低正式门槛或把smoke算正式数据。
冻结运行器额外记录helper的hash，避免报告漏记驱动依赖。

纯测试2pass：墙钟禁止访问仍完整等待1250ms；500ms内响应stop请求。
新真实Electron smoke退出0：desktop-soak-2026-09-23T16-59-32-501Z-smoke-11123bac，
24个真实host ACK、3次关闭/恢复循环；实际单调elapsed25225.7342ms；关闭后无Mods pane/utility。
记录保留input/frame/ACK和内存快照；smoke qualified=false，绝不是2小时/10000事件或内存验收。
Node/Web typecheck与修改范围ESLint exit0。未改产品执行逻辑。

正式CPU/stream重测、真实2小时soak仍待完成；当前文档不宣布任何正式性能预算通过。
