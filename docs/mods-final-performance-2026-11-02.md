# Mods 最终性能与长稳结果

2026-11-02：计划内性能执行已经结束，**整体性能未通过**（`overallPerformancePassed=false`）。功能验收、诊断成功和长稳通过不能替代未过的原性能门槛。应用版本仍为2.0.0。

基线为 `15492cc9fc3f4364d09403b8e0f4691a2554ff80`。当前产品源码截止 `d458162fbec35cbfa636260fbbb833f6b62906f1`；后续43561b6、6bd4073、f8084d1之间的 `src/`、`resources/`、`package.json`及lock文件产品输入差异为空，但测试driver不同，须按下表分别引用。本文及后续文档提交不代表重新运行了所有套件。性能和短诊断均未请求商业模型。

## 主结果

| 项目 | 实际driver HEAD | 结果与原门槛 | 证据目录（仓库内） |
| --- | --- | --- | --- |
| Runtime ABBA | 43561b6 | 110060事件完成；禁用入口相对同轮direct的5%门槛有10/20行失败（baseline 4、current 6）。单插件合并p95为4.7100→4.7788ms，各原始行均≤15ms | `output/phase3-performance-runtime-9b2ed6e4` |
| Native ingress ABBA | 43561b6 | 154060事件；单插件15ms门槛20/20行失败，禁用入口5%门槛40/40行通过。单插件合并p95为18.0634→18.0637ms；8链32.2761→33.1720ms（+2.78%），套件退出2 | `output/phase3-performance-ingress-76b04ff9` |
| MCP resolver | 6bd4073 | 16个真实Electron main子进程、1600条实测timing；合并p95为10.3715→10.3464ms（−0.242%），退出0；此项未另设通过门槛 | `output/phase3-performance-mcp-ac1d6b57` |
| 整应用idle CPU | 6bd4073 | off/on各约300017ms；CPU为2.0317%→2.1512%，增量0.11945个百分点≤0.5个百分点，通过 | `output/phase3-source-desktop-performance-0f239fc9` |
| Protected SSE | 6bd4073 | off取得10个样本后，首个enabled warmup报`DESKTOP_STREAM_CONTENT:320`、退出1。TTFT/吞吐比较未qualified，原门槛未通过 | 同上 |
| 普通聊天UI及重载诊断 | f8084d1 | 原composer/send两次本地请求；即时与重载后两个独立消息均只有一份正文，退出0。诊断Only、不可当作性能成绩 | `output/phase3-source-desktop-performance-9e784f8d` |
| 正式桌面长稳 | f8084d1 | 10000事件、40轮关闭/重载、261个自然堆样本；实际首末跨度129.90分钟。renderer自然used heap原门槛通过，退出0 | `output/phase3-source-desktop-soak-b72333f9` |

## 比较方法与不能省略的失败

Runtime保留20组disabled/direct双臂共40000条原始样本；ingress保留140000条原始样本。两套中的0/1/8 VM矩阵，其冷起、100次warm和每轮1000次sample均在baseline/current使用相同25ms最小实际启动间隔，不追赶慢调用；等待不计入单次延迟。这是≤40Hz声明负载的延迟比较，不是饱和吞吐。disabled/direct成对交错和MCP原140-call负载不施加该等待。每次事件的链路hops、mask及存活校验保留，冷起值也未删除。

Runtime的current相对baseline合并off延迟仅约+0.952%（+0.0073ms），不能抵销相对同轮direct的10行5%门槛失败。合并统计只作描述，不替代每行原判定。首次突发基线触发原500ms/5秒CPU保护的诊断和不完整样本仍保留，未改产品预算或历史基线来取通过。

MCP的2240次调用依据16次原140-call及audit断言成功，不是2240份独立原始工具回执；原始实测timing为1600条。为承载完整源码依赖，测试修复了精确ESM入口和真实Electron main启动方式，两侧一致，未替换生产实现或减少原负载。首次采样前失败保留。

## SSE与普通UI的边界

正式desktop场景开启`outputPolicy`。`function-conversation-native-host.ts`的保护分支有意抑制partial，仅发布安全canonical final snapshot；短诊断确认服务端仍分40次写入，而enabled callback只收到一次完整320字符snapshot，`first===last`。因此不将正文正确误写成TTFT/吞吐通过，不关闭保护、放宽原断言或在本轮新建复杂的安全增量协议。

`91c47d33`和`4de0eb11`是直接API的短诊断，Only/ineligible，不是正式性能；未等到目标DOM行只能记unknown。旧`0f239fc9`双正文截图没有锁定到本次canonical身份，原因仍unknown，不据文字重复做去重修复。

另一次`9e784f8d`使用原ChatContainer composer/send，经真实transport连续off/on各一次受控本地SSE：2个请求各40次写入，0商业模型、0工具调用。持久DB两个独立ID的正文均为320字符，SHA相同；即时和原页面重载后，两ID均各有一个目标行和一份outer正文。DOM为319字符，原因仅为固定夹具唯一末尾ASCII空格被Markdown省略，未泛化trim或合并相同文字。两路medium独立读DB、PNG、SHA、来源和进程状态通过；只证明此普通UI及重载路径，不抹去旧截图unknown或protected SSE失败。

## 自然堆长稳范围

261条样本来自同一renderer PID35204及creation `1793559379977.258`，全程匹配50 jobs/4 panes。实际首末跨度7793957.63ms，最大采样间隔37294.8202ms，heapErrors为0，无强制GC。首窗口21条、跨度600113.8884ms；末窗口22条、跨度622364.4691ms，两窗口不重叠。

依原nearest-rank 50%统计，38004872→35498088字节，增长−2506784字节；预算为max(10MiB,初始中位数10%)，即10485760字节。原`qualified/passed`均为true。此处“中位数”遵循既有nearest-rank规则，偶数样本不取中间两项平均。

10000条事件顺序完整，四面板各2500次；每次等待真实精确ACK后才记入事件，重载后再核累计ACK。40轮off/重载和最终off保留，最终pane及所属Function Mods utility均为0，正常`app.close`及wrapper退出0。没有声称保留每次ACK全文或完整录像。

两路非作者复核涵盖原始样本、窗口、身份、状态和哈希；4555个source、964个candidate资产、115个driver文件均无差异，manifest及driver围栏通过，结束后owned进程为0。结论仅为同暖态窗口下的**renderer自然used heap**增长合格，不证明全应用live heap、RSS或“没有内存泄漏”。环境中的Skills Response-notJSON展示问题另列，不声称全UI零错误。

## 后续

先复查通用热路径成本和原预算：disabled/direct差异、ingress入口及保护输出的适用范围。任何优化须有相同语义和安全围栏的回归，再以原门槛验收。之后按[迭代路线](mods-next-iteration-roadmap-2026-11-01.md)推进可信发布与安全更新；[市场方案](mods-workbench-market-product-plan-2026-11-01.md)仍是规划。

功能、环境阻塞及历史失败见[完整验收记录](mods-nonmedia-and-phase3-verification-2026-11-01.md)。首次全量npm约92分钟后仍有22个失败文件、77项失败及worker RPC异常；定向修复通过不等于全量重跑全绿。原项目四个保护文件、AutoBiz原始模板和旧output材料保持，不在本轮性能收口中改动。

汇总事实源为 `output/mods-phase3-final-performance-f8084d1.json` 及同名`.md`，具体门槛、cold值和每条样本以各目录原始analysis/comparison为准。上述artifact路径属于开发仓库，不假定D盘分享包包含output。
