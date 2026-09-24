# v63 入口正式性能复检 — 2026-09-24

冻结 HEAD `a447abe0`；exec29180 exit2。独占运行，未并行构建、Electron或重测试；未修改生产或测量驱动。

5轮，每组1000样本、100预热；38515个真实 LocalSandbox/read_file 事件，耗时299212ms。实际 utility/guest hop与bit验证保留。`qualified=true`、`budgetsPassed=false`、`qualificationStatus=failed-budget`。

| 轮次（0开始） | 模式 | p95增量ms | 增量% | 5%门槛 |
| --- | --- | --- | --- | --- |
| 0 | project-off | 0.0633 | 2.2343 | 通过 |
| 0 | global-off | 0.2151 | 9.4695 | 失败 |
| 1 | project-off | 0.2379 | 10.7681 | 失败 |
| 1 | global-off | 0.1054 | 4.5240 | 通过 |
| 2 | project-off | -0.1347 | -5.3856 | 通过 |
| 2 | global-off | 0.1833 | 7.9852 | 失败 |
| 3 | project-off | 0.1320 | 5.6762 | 失败 |
| 3 | global-off | -0.0227 | -0.9760 | 通过 |
| 4 | project-off | 0.0609 | 2.6378 | 通过 |
| 4 | global-off | 0.0639 | 2.8226 | 通过 |

单插件p95五轮均低于15ms；关闭10组4组失败。关闭均0发现、0 runtime启动，结束activeCount=0。小绝对增量并不豁免既定5%门槛。未丢弃失败样本、增加重试或改变阈值。

原始证据目录：`v2-ingress-2026-09-24T07-11-37-215Z-matrix-d3700f26`（run/options/result/exit及各组samples）；日志`2026-09-24-v63-ingress-formal.log`。测试夹具使用可控内存global开关，不等同整桌面配置读取开销，也不覆盖UI/流/CPU/两小时长稳。

后续：检查经典Hook在Mods关闭时仍执行输入投影/结果回译的路径，先增加关闭与无manager一致性回归，再考虑最小修复；尚未确认它解释全部差异。
