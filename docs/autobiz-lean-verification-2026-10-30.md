# AutoBiz 四阶段与 Host 快照复验

> **历史测量记录。** 本文记录独立架构评审前的四阶段样例，不代表最终版本已验收。
> 评审后流程增加独立需求基线，变为五阶段，并修正规则替换、上下文依赖和来源校验。
> 当前设计及实现范围以 [新版说明](./mods-lean-plugin-explained-2026-10-30.md) 为准。
> 下文的材料字节数与性能观测保留用于追溯，不能作为修订版的最终测量结果。

范围：`codex/mods-v2`，应用版本仍为 2.0.0。未打包、未提交、未触发 Actions。
旧 AutoBiz 作者源及原规则源保留；新版入口为
`resources/native-compositions/autobiz-lean/devclaw.source-set.json`。

## 业务与真实执行

新版为 Definition → Solution → Code → Delivery。定义与方案使用原生 JSON 对象，
复用原只读业务算法而不调用旧阶段状态机。知识、纯业务规则、真实交付证据为三个独立 Mod。
`contextArtifactIds` 仅指导初始阅读，完整输入、内容指纹和检查不减项。

`autobiz-lean.test.ts` 的 7 项验证包含真实 provider 编译、source-set 读取、
作者源编译/doctor、实际 Python 业务规则、实际 helper、坏引用/缺要求/陈旧设计锁/
错误场景/改动原字节/虚假发布/损坏归档负例、知识阶段选择和真正更名独立 provider 的替换。

`autobiz-lean-host.integration.test.ts` 运行原 Host 服务、快照、配置授权、Function Guest、
Flow、Python、workflow 引擎、实际 Git 工作树/合并、实际 Node 测试与原生回执。
模型写作受控，审批与成果接受使用真实 Host 接口，由测试注入用户决定，未声称人工点击 UI。
验证缺少两秒约束的 Definition 失败、修复后通过，方案经审批接口接受后改动 Definition
一个字节即拒绝推进；Code/Delivery 业务与原证据通过，各接受门独立验证，最终 Host 项目完成。
Code 回执跨线程读取仍绑定原生产操作。
这不是对某个用户真实项目的模型质量、外部发布或部署成功声明。

默认执行适配器有明确边界：最多 8 个跟踪的生产 JS 模块逐个语法检查，真实 Node 原生测试，
混合未支持生产扩展明确拒绝。正常链和下述真实 source_bug 修复链均已完成全链验证。

## 上下文测量

固定样例中，实际编译技能、实际 context 回调输出、必读契约全文的 UTF-8 字节合计
从 89,485 降至 25,211（约 71.8%），知识材料 API 调用从 42 降至 20。
测试输出逐阶段明细；测量包含移出 Skill 的必读契约全文。
它不包括模型历史、后续产物读取、workflow 子代理提示和工具返回，不能解释为总 token 或费用下降。

## Host 性能根因及处理

原链：`HostProjectService.fingerprint()` → `snapshot()` →
`HostPackageSnapshots.read()` → `readTree()`，在每个输入核对中重新完整读取/hash同一固定包。
`project-action-executor.ts` 的 `assertInputs()` 另有独立全包读取，
`project-workflow-evidence.ts` 在原运行加载和分页前后重复检查内容。

本轮仅优化 Host service 层：在单次 `executeSkill` 异步作用域中，
全字节准入后复用该快照描述，每次仍执行既有 `captureGuard`。
guard 核对 dev/ino/mode/nlink/size/mtimeNs/ctimeNs、目录与路径，变化立即拒绝，
不在运行中重新接纳变化的基线。授权、操作身份、配置、知识和输入字节仍走原检查。
开始新的 Host 操作退出继承作用域；物理执行结束立即失效。
原动作 executor 的完整内容核验，以及作用域外最终校验/状态提交完整读取保持不变。

`host-service-snapshot-scope.test.ts` 8 项通过：同长度并恢复 mtime 的字节改动、
新增/删除、父目录替换、junction、授权 epoch 改动、退出后的回调、新阶段重新准入，
以及连续重复检查不再重新读全包。原 Host service 48 项与包快照 3 项亦通过。

同一 44 文件样例的真实对比输出：

```text
checks=25 files=44 beforeFullReads=25 afterInternalFullReads=0
baselineFullReadMs=5323 guardedFingerprintMs=576
```

新增准入和最终/派发全读不计入上面的内部查询次数；它们仍执行。
日志：`%TEMP%/host-snapshot-comparison.log`。

实际 Host 集成观察（单次运行，存在同时测试负载；不是稳定的性能基准）：

| 项目 | 优化前 | 优化后第一轮 |
| --- | ---: | ---: |
| Code evidence 动作 | 75,002 ms | 51,600 ms |
| Code 阶段 Host snapshot 检查次数 | 193 | 193 |
| 同上累计耗时 | 31,719.7 ms | 2,967.1 ms |
| Delivery evidence 动作 | 35,011 ms | 22,083 ms |
| Delivery 阶段 Host snapshot 检查次数 | 70 | 70 |
| 同上累计耗时 | 11,842.6 ms | 1,096.4 ms |
| 全部四阶段测试 | 285,332 ms | 244,315 ms |

优化前原始数值来自该次 Vitest 工具终端输出，未保存单独日志文件；本表保留观测摘要。
优化后日志为 `%TEMP%/autobiz-lean-host-after.log`。
优化前代码样例为单模块、优化后为双模块，因此全链耗时只作观测，不作为严格 A/B。
剩余成本仍包括原动作 executor 的全包校验、输入/原证据检查与真实 Git/测试执行。
没有通过删检查或压缩业务覆盖把这部分成本隐去。

最后冻结的混合源码边界版本 Host 全链已通过，日志为
`%TEMP%/autobiz-lean-host-final.log`：总测试 220,060 ms，Code evidence 48,376 ms，
同阶段 snapshot 193 次/2,889.7 ms；Delivery evidence 20,810 ms，
同阶段 snapshot 70 次/982 ms。两模块真实编译、测试、回执和四阶段最终完成均通过。
最后快照边界 8 项再次通过，日志 `%TEMP%/host-snapshot-scope-final.log`；
该轮独立 25 次对比为完整读 4,457 ms、guard 加完整输入指纹 507 ms。

## 真实失败与源码修复补验

首次执行真实 Node 测试，2 项中 1 项失败（退出码 1），暴露 retained UT 规则只认识旧 argv，
拒绝新版 `node - <adapter JSON>` 的接口缺口。修复是在原纯规则中增加可选命令验证器，
保留旧默认行为及原 task/spec/AC/摘要/最近失败证据/预算校验。新版验证器仅接收原工作流
读取的失败回执，绑定实际 argv、测试与被测路径、时限、摘要和非零失败统计。
未修改平台 service/session，也未将真实失败伪装成成功。

受控实现者只修复生产代码，原测试不变，重跑 2 项全部通过；再次真实编译、Git 封存/合并、
最终 E2E 和原 Code 证据通过。重放没有新增模型/process/审批调用，上游原字节改动仍拒绝。
`autobiz-lean-code.integration.test.ts` 通过，94,237 ms。
`autobiz-lean-host.integration.test.ts -t "real failed Node"` 通过，297,760 ms：
真实四阶段 Host 检查、审批接口、成果接受与状态提交最终为 completed；用户决定由测试注入。
该次 Code snapshot guard 240 次共 3,749.7 ms；Delivery evidence 29,493 ms。

`autobiz-lean-delivery.test.ts` 16/16 通过，包括真实失败统计、空/矛盾/跳过统计、错误文件/
源码绑定/runner/摘要、原命令变更拒绝，以及原规则与适配版本来源摘要校验。
Node typecheck 与本次四个 helper/test 的 ESLint 通过。
本次新增的全链证据专指 source_bug；test_bug 的有界逻辑仍保留，未将其声称为该次实际执行。
本地日志：`%TEMP%/autobiz-lean-code-repair.log`、`%TEMP%/autobiz-lean-host-repair.log`。

## 显式 Java/Maven 执行适配器

恢复旧版已验证的业务路线：真实 Maven compile，独立 Python unittest 调用编译后的 Java。
通过项目配置 `executionAdapter` 显式选择 `python-unittest/v1`，默认仍为 `node-test/v1`。
Code/Delivery 的 configurationKeys 绑定 Host 真实配置，workflow 结果、测试契约、prepare-test、
各实际编译/测试回执均需同一选择和锁定 provider 身份；不能用更换配置复用旧结果。
Java 编译前后源码 SHA 一致，最终 E2E 被测文件清单与摘要必须等于最终编译的 Java/POM 清单。

独立真实 workflow、Git、Maven/Java/Python、重放、Code gate 通过（84,001 ms），
并验证更换适配器配置和修改上游原始字节均拒绝。
业务编译/知识/替换及适配器窄测试初轮 31 项通过；补充显式选择与跨适配器拒绝、
Maven 成功返回后源码被改动的负例后，两个适配器边界文件 25/25 通过。
这里的 Java 测试实际执行两项行为断言，包含两秒时限及缺失订单，不只依赖退出码。
本地日志：`%TEMP%/autobiz-lean-java-code.log`、`%TEMP%/autobiz-lean-adapters-boundary-final.log`。

联合 Host 三场景在相同接线版本均通过：Node 正常 296,005 ms、Java/Maven 正常 301,741 ms、
Node 真实 source_bug 修复 303,283 ms（整文件 914.57 秒）。三条均执行实际四阶段检查、
真实审批/接受接口、原 Code/Delivery 证据及最终 completed；模型输出与用户决定由测试控制。
日志：`%TEMP%/autobiz-lean-host-adapters-final.log`。

随后独立审查指出 Java CLI 可以通过旧编译策略允许的参数跳过/筛选源码，且批次测试尚未
像最终 E2E 一样绑定编译输入 SHA。已收紧为根工程 compile 的明确选项白名单，保留旧规则
前置；每条 Python 成功批次测试、修复重跑和最终 E2E 都绑定之前最近同仓、同 taskIds 的
真实编译清单与 SHA。不能越过较近失败编译借旧成功回执，不能借其他仓或其他任务的编译。
该最终收紧只影响 Java 适配器；Node 逻辑未改变。
新增 8 项 Maven 参数及原回执关系负例，与两种适配器边界共 33/33 通过。
日志：`%TEMP%/autobiz-lean-java-hardening.log`。受影响 Java Host 的最终复验见下文。

交叉复核进一步发现原生回执分页按持久化哈希键排序，并非执行时间顺序。最终代码在验证
原 run 的固定脚本 SHA、executionIds 唯一且精确覆盖所有原 action 后，按该固定脚本中
receipts.push 形成的原 result.executionIds 排序，再寻找最近编译；不接受 Code.json 指定顺序。
新增“原分页先测试后编译”的乱序回归，连同未知/重复 ID、陈旧源码摘要拒绝，Java 门禁
专用文件 9/9 通过。原批次与预算、身份和来源校验均保持。

最终 Java 收紧版本已通过独立复核，随后受影响 Host 场景完整复验通过（273,625 ms）：
真实 Maven 编译、Python 调用 Java、工作流重放、每批及最终编译源码摘要绑定、Code gate、
跨线程 Delivery 原证据与最终 completed 均通过；模型作者和用户决定仍由测试控制。
只重跑受影响 Java 场景，没有重复消耗两条已通过的 Node Host 链。
最终日志：`%TEMP%/autobiz-lean-java-host-final.log`。
