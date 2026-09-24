# v63 正式桌面性能门禁 — 2026-09-24

冻结提交3c569546，宿主修订guest-codegen-boundary-v63。运行 node tests/run-mods-desktop-soak.mjs --performance，exec70692 exit0。目录desktop-performance-2026-09-24T06-25-53-608Z-full-5f99565a内run.json保留应用/资源和driver指纹、运行前HEAD/状态；期间未修改生产或冻结驱动，没有并行build/测试。只有只读复核及未接入的新测试/文档准备。

## 实测

- qualified=true，passed=true。关闭和开启各完整300秒空闲窗口，CPU差-0.063675564单核百分点，预算≤0.5。
- 5轮交替开关，关闭50样本、开启50样本；另10次warmup，共110次真实主Agent/provider-client向受控本地SSE服务的请求。没有模型重试或完成修复。
- 关闭TTFT p95 187.1ms，开启212.8ms，增量25.7ms，预算≤40ms。
- 相同320字符流吞吐比0.994926868，预算≥0.95。
- 关闭p50 141.2ms，开启195.1ms；本次p95门槛通过不意味着所有分位数增量都≤40，也不证明某一改动单独造成改善。

8个真实批准插件、4个真实Client Pane，原权限/模型/IPC/完成链；idle时关闭Pane，stream时保留Pane。首字时间是原preload IPC收到首个文本的时间，不是外部模型推理或最终DOM绘制延迟；字符吞吐不冒充provider token计数。

## 未覆盖

不是Autobiz业务验收，不是两小时长稳/内存门禁，不是关闭入口微基准。之前full4的TTFT +67.7ms失败原样保留。正式ingress关闭1/10超预算与6408事件实际ACK失败仍是独立未完成项，不能因本次桌面性能通过而删除。后续生产改动需与本冻结基线区分并做相关回检。
