# Mods 收敛改造实施记录

> 后续复检：本文的完整绿色记录对应审查修复之前的源码。四项问题修复后的最新测试结果、
> 全量失败及原时限复验见 [修复与复审记录](mods-review-fixes-2026-10-22.md)，不能沿用本文的绿色结果放行。

日期：2026-10-22。适用工作树：`C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
本文记录本轮冻结源码及分层验证状态。完整 `npm test`、Node/Web TypeScript 已通过；
变更文件 Lint 无错误，整体 Lint 仍有已归因的既有错误。最终结果及未验收边界见下文。

## 1. 结论与当前边界

本轮已将被动内容显示与有权限的交互生命周期拆开：宿主可对确定无匹配的正文执行原有保护，
对证明可复用的被动结果保留非权威快照；动态或有副作用的绘制仍使用原 guest/owner 路径。
缓存不保存批准，不因切换显示路径而重放工具、动作或业务提交。

当前已经存在相关源码、统计工具及分组回归，不能据此宣称全部阶段完成或卡顿已解决。
实施阶段未获授权构建、打包、推送与 Actions，因此该阶段未构建新应用或安装包。
后续用户已明确要求提交并推送当前开发分支，提交说明见最新修复与复审记录；不新增打包或发布操作。
已有 `out/`、旧安装包及历史绿色结果不能代替当前源码的整包验收。

## 2. 基线与结果身份

初始 HEAD 为 `403affb132e74a2e63bc1b51deab5fad384b7803`；实施前已经存在功能、设置、文档及
版本变更。本轮保留了这些改动，没有以重置工作区的方式构造基线。

初始身份保存在 `output/mods-convergence-p0-20261022/baseline-manifest.json`，包含原始 diff
摘要、Node/Electron、匿名机器身份、电源与显示信息、脚本和既有输出 hash。原始 diff SHA256：
`822f5a067f1d38985d2b61395276aba24a1a7cd091f4b9774895b62ad2969c9e`。
后续采样不得覆盖这份初始记录。

已使用实施前保留的 24 个公开 tracked dirty 路径重建原始二进制 diff，62856 字节及上述 SHA256
均完全一致后，才保存 `output/mods-convergence-p0-20261022/original-baseline.patch` 和独立
`baseline-reproduction.json`。两文件均被 Git 忽略，初始 manifest 未覆盖；未读取用户报告、敏感
配置或未知的未跟踪文档，也未应用补丁。该记录用于复现原 tracked 基线，不代表执行了新构建。

测试使用现有 Node 22.22.2、npm 10.9.7，锁定 Electron 39.8.10。
本机显示适配器记录为 144Hz，尚不满足计划中的固定 60Hz 时间验收条件。
旧 renderer 报告带 CPU Profiler/Tracing，仅作为定位证据；不作为无 profile 的 P95 放行结果。
详细约束见 [P0 决策、安全矩阵与验收记录](mods-convergence-p0-acceptance-2026-10-22.md)。

## 3. P0—P6 实际实施状态

| 阶段               | 已落代码与作用                                                                                                              | 当前证据及仍需完成的验收                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| P0 基线与验收      | 初始 manifest 与精确匹配的 tracked baseline patch；验收统计工具                                                             | 成本诊断 3/3、统计规则 9/9；固定机器五轮 A/B 未验收                                                                                |
| P1 宿主显示路由    | `static-ui-render-summary.ts`、`display-native-projection.ts`；manager 保留编排入口；普通、空白与长消息均接入受保护显示合同 | 路由及成本组 31/31；动态旧来源明确保留原 owner 路径，不把保守回退改成零求值；新包待验收                                            |
| P2 被动快照与失效  | 原 named-state 依赖 proof、纯投影/稳定工具 ID、精确失效、Main 及 renderer 有界缓存                                          | 物理资源组 46/46；主进程 admission 40/40；两端重入 Main 58/58、renderer 40/40；阶段分组 369/369；最终全量通过，整包/长期验收未完成 |
| P3 guard 与准备    | identity/full guard 分层、同键冷读合并、含 waiter 的物理上限 256；原生 load 通道准备摘要并绑定真实 runtime                  | native 准备组 52/52、来源安全组 80/80；每 waiter 保留最终完整 guard，未给出整包主线程/吞吐放行结论                                 |
| P4 Markdown 与布局 | 纯 AST 缓存、安全闭合代码围栏前缀、geometry 聚合；真实 prepend 短暂视觉补偿                                                 | Markdown 局部 26/26；prepend 15/15、三次独立 browser 零空帧；最终聊天 8 脚本通过，固定机性能门槛待验收                             |
| P5 模块与边界      | 新显示模块不反向依赖 manager；`display-module-boundary.test.ts` 用真实 AST import 关系检查架构边界                          | 新边界 3/3 通过；manager 仍为原编排 facade，本轮不能称整个大类已经完成全量拆分                                                     |
| P6 回退与发布准备  | 普通被动投影/缓存启动开关、协议 epoch、物理 draining/unknown fence 与 256 请求总上限                                        | rollout 11/11；源码回退/未知态回归通过；长消息双保护保留；新包、升级/降级、灰度及 2 小时浸泡未验收                                 |

### 被动缓存的限制

快照为展示数据，不能带 `owner`、callback、Client 或可复用的 action authority。
静态分析无法证明 matcher/绘制可复用时，保留原始管线。named-state 依赖需要在 DOM owner 释放后
继续有效，相关状态变化只使相应结果失效；缓存淘汰必须释放对应监听。
不得把“AST 看起来简单”直接当成无副作用证明，也不能通过双跑真实副作用来比较新旧结果。

### 已落盘的显示接线与边界

1. **按组件路由。** 根据实际编译结果生成保守匹配摘要，在申请 guest 绘制 owner 前区分可证明
   无匹配与可能匹配。仅 AbovePrompt 的字面注册可使正文走宿主保护投影；动态 matcher、未知
   闭包或不能证明的旧实现仍走原管线。来源证明和输入、输出保护继续执行。
2. **正文与长消息。** `host-message.ts` 为超过原 guest 正文上限或空白的消息提供宿主专用 DTO，
   仍保留原 ModJson 传输上限，不扩大 guest 的 10,000 字符接口。保护后正文以一个完整原生正文
   渲染，保留远端引用、表格、选区及复制语义；UserMessage 的 origin、展开标记和 AssistantMessage
   的回复标记由宿主固定。保护失败不展示原始 fallback；没有新协议的 peer 保守拒绝该受保护路径。
3. **快照与交互分离。** `siteRead` 返回纯 projection 或真实 mounted owner 两种合同，不把缓存
   包装成 `FunctionPaneSnapshot`。字面状态依赖由原 named-state 读引擎捕获并同步核对实际读取
   覆盖；缺失键的版本 0 也必须真正读过。handoff 后 proof 继续存活，按宿主快照 key 精确失效。
   动作、Client 和含有主动字段的工具数据保留真实 owner。稳定工具显示 ID 只取实际 tool_use_id
   的有序组合；命令输出只取 job.id 与 output/error 通道，不使用命令参数或正文作为稳定 ID。
4. **预算与重挂。** Main 缓存上限为 14MiB；同一 renderer 进程的所有 provider 共享 2MiB LRU，
   后者计入正文、缓存键、稳定 row admission、失效日志及缓存元数据。每 scope 96 条、单条
   128KiB、保留 120 秒的上限保持；多个 renderer 进程各有预算，不能合称全应用固定 16MiB。
   共享索引仅持弱引用，主动失效释放额度，跨实例淘汰仅通知对应 key。hostMessage 缓存保留经
   校验的纯 props，不存空 engine 假帧；重挂期间保持 inert，重新通过宿主校验后才恢复当前原生交互。
5. **Markdown。** 仅缓存固定语法配置、精确输入对应的纯 AST，并以深克隆隔离后续转换；不缓存
   React 节点、预览权限或工作区回调。清洗、转换、搜索和复制仍逐次走原管线。流式优化只冻结
   可证明独立的前导闭合代码围栏；任意 Markdown 及跨块语义继续完整解析，完成态与完整 oracle 比较。
6. **主进程冷读合并。** `FunctionNativeDisplayProjection.reuseOrRun` 只合并已证明被动、同 scope、
   同 row 和同版本的进行中求值。等待者在物理 producer 结束后重新执行自己的完整来源和权限
   guard，仅复用已保留数据，不取得另一视图的 owner。未生成有效可缓存数据时继续真实路径；
   合并键数限制保留；`HostDisplayRollout` 对包含同键 waiter 的物理读总量实施 256 硬限，只有
   实际物理结束才释放额度。工具、动作和业务提交不进入该合并。

原 renderer 已有每实例一个在途读取及一个布尔待刷新请求，完成后再取最新 input；此处继续
复用，不新增第二个滚动/执行状态机。上述接线证明特定路径减少重复绘制，不证明全场景已无卡顿。

### 冻结源码的最终补充

- **全局切换与缓存索引。** 仅使用宿主投影、没有 guest/session 的工作区也纳入原生失效集合，
  全局关闭再开启会退休旧 scope，跨等待迟到的结果不得发布；真实 Main 红绿回归组合 52/52。
  renderer 缓存键对精确输入的 JSON 表示生成 SHA-256 摘要，不保留原始输入正文；摘要仅作
  非权威索引，不能替代权限或来源校验。组件按输入、行身份和宽度 memo，保留 ABA 失效语义。
  UTF-8/块边界/Unicode oracle 及缓存组合 53/53、工具展示 browser 8/8、hostMessage browser 5/5。
  证据为 `output/display-source-free-global-final.log` 和
  `output/presentation-input-digest-units-final.log`、
  `output/presentation-input-digest-tool-browser-final.log`、
  `output/presentation-input-digest-host-browser-final.log`。
- **两端缓存重入。** Main 和 renderer 的清理/淘汰观察者执行期间不允许同步重新写入缓存；
  被回调失效的在途记录不再登记为 phantom，也不留下未计费正文或元数据。renderer 同一通知
  cascade 对每个订阅只通知一次，同时保留嵌套不同 key 的精确通知。修前失败日志保留，修后
  Main 组合 58/58、renderer 组合 40/40；这不是两小时内存泄漏验收。
- **P3 原生准备通道。** 在现有 utility 的真实 load handler 中准备保守组件/可复用摘要；
  RuntimeClient 通过已认证的原生 load 交换，核对真实 client、physical lifetime、runtimeId、
  code 与 registration 摘要后绑定 proof，原生活动 proxy 只继承该不透明绑定。任意 guest、
  伪造 JSON 或旧 peer 不得据此请求 Main 分析/取得可信摘要；未知或超准备预算仍回兼容路径。
  最终磁盘来源与授权 guard 保留。原生接线组 52/52、来源/物理生命周期安全组 80/80 通过。
- **实际能力目录消费者。** `developmentCatalog().hostDisplay` 调用统一的
  `describeFunctionDisplayRouting()`，由同一目录向创造者和开发工具说明显示能力与限制；
  目录回归验证真实返回值，不是仅新增未使用的说明常量。
- **prepend 视觉事务。** `ChatVirtualPrependLayout` 仅在同一虚拟窗口的实际 prepend 上，以当前 DOM
  锚点临时补偿 Virtuoso 的 margin deviation，随后由原生滚动完成事务；不改原生滚动偏移、
  行高缓存或消息身份，不保留历史交互节点。用户输入、窗口/线程变化及卸载立即结束补偿。
  三文件 15/15 单元、三次独立浏览器复验均为 0 empty/visible-empty frame，原有效安全断言未放宽。
  列表修复后再次串行执行完整 8 脚本，全部通过；不把前一轮修复前的 1 帧记录覆盖或删除。

阶段冻结的变更集合共 30 个测试文件、369/369 通过；完整 Node 与 Web TypeScript 通过。
此后来源复核边界的组合为 6 文件 72/72，证据为
`output/mods-convergence-p0-20261022/display-final-capture-guard.log`。各分组重叠，不能相加。
完整 `npm test` 已通过，最终冻结结果见第 4 节。整体 lint 的 172 个错误已归因：171 个位于未改动的 HEAD 文件，
另 1 个变更测试中的错误已修复；变更/新增源码未引入 lint 错误。完整 lint 仍非绿色，不能以
局部或基线审计替代整体通过，证据见 `output/convergence-whole-lint-error-attribution.json` 与
`output/convergence-lint-baseline-audit-final.json`。

### 来源 guard 的限制

identity guard 仍须实时验证原生 scope、epoch、rollout、session/transport、批准与配置身份。
完整 guard 继续核对真实来源内容与原有文件身份。不能把 grant 或来源真实性变成永久缓存。
纯 Map 操作、已编码 JSON 处理可以减少重复扫描；监听、依赖释放、淘汰通知等回调可能重入，
不能无条件视作纯操作。独立请求与异步等待后必须重新复核，单个 producer 通过不代表其他
single-flight waiter 可以跳过自己的最终复核。

当前组织保护规则在启动时读取并复制，运行期间没有规则热更新入口；展示缓存尚未显式绑定可变的
policy digest，安全依据是固定策略实例及现有授权/配置失效链路，不能用 `protects` 布尔值充当策略版本。
若以后增加规则热更新，必须同时引入策略版本绑定及同步缓存失效，才能开放该入口。

### 回退的限制

主进程启动环境变量 `DEVCLAW_MODS_DISPLAY_PROJECTION=0` 停用普通被动投影与缓存复用；Mod 无法控制此开关。
该回退不关闭长消息、空白消息的安全展示合同：已协商新协议时仍经过专用 hostMessage DTO 的
两次保护，且不保留缓存；未知 peer 按旧合同及原有长度限制处理，不能退回未保护原文。
新协议为 `mods.display/v1`；未知 peer 使用 legacy 合同，不混用 DTO。
切换先停止新 admission，提升 epoch 并失效纯展示数据；旧结果即使迟到也不能发布。
物理操作尚未结束仍计在途，未知结果不改成成功。`HostDisplayRollout` 是内存生命周期 fence，
不代替持久动作日志、真实物理进程证明或业务恢复服务。
方案中准备通道、刷新合并、Markdown 或布局的分别回退是源码级方案与后续演练要求；当前
没有为每个子优化提供独立运行时开关，不能将其表述为已经完成的多开关回退演练。

## 4. 已执行的窄范围证据

以下是分组测试，不等同最终工作区全量回归；测试期间仍存在其他代理的并行改动。

| 范围                                    | 结果                                         | 证据                                                                                                                                                |
| --------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生来源成本诊断                        | 3/3                                          | `output/mods-convergence-p0-20261022/manager-baseline.log`、同目录 `manager-baseline/*.json`                                                        |
| 统计、合法规模、冷读及内存窗口规则      | 9/9                                          | `output/mods-convergence-p0-20261022/acceptance-unit-final.log`                                                                                     |
| 回退生命周期 fence                      | 10/10，独立 strict TypeScript 与 ESLint 通过 | `output/mods-convergence-p0-20261022/display-rollout-unit-final.log`、`display-rollout-typecheck.log`、`display-rollout-lint.log`                   |
| 模块依赖边界                            | 3/3                                          | `output/mods-convergence-p0-20261022/display-module-boundary.log`                                                                                   |
| 路由、真实来源成本与兼容旧来源          | 3 文件 31/31                                 | `output/mods-convergence-p0-20261022/display-routing-manager.log`                                                                                   |
| 主缓存、纯投影及回退生命周期            | 3 文件 40/40                                 | `output/convergence-cache-lifecycle-final.log`                                                                                                      |
| 主进程冷读合并与真实 guest 投影         | 2 文件 37/37                                 | `output/convergence-cold-read-singleflight.log`                                                                                                     |
| renderer 共享预算、投影与 scope（早期） | 3 文件 36/36；重入修复后的最终结果见下表     | `function-site-presentation.test.ts`、`function-site-projection.test.ts`、`mods-chat-scope.test.ts` 本轮 Node 22 双 worker 输出；联合浏览器日志见下 |
| Markdown/geometry 局部单元              | 5 文件 26/26                                 | `output/p4-markdown-geometry-unit-final.log`                                                                                                        |
| Markdown 真实 DOM cache 与前缀          | 两份受控浏览器输出 PASS                      | `output/p4-markdown-cache-browser.log`、`output/p4-markdown-live-prefix-browser-final.log`                                                          |
| 串行源码浏览器联合回归                  | 14/14 脚本；附加六组共 71 个命名行为场景     | `output/convergence-browser-regression.log`                                                                                                         |

阶段冻结及修复期间的补充证据如下。各分组有重叠，不相加作为独立用例总量；
最终冻结源码由本节末的统一回归覆盖，不能将较早分组的源码身份当成最终身份。

| 范围                              | 最终结果                                                        | 有效证据                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 变更集合                          | 30 文件 369/369                                                 | `output/convergence-changed-tests-final.log`                                                                                                                                            |
| 完整 Node/Web TypeScript          | 通过                                                            | `output/convergence-types-final.log`                                                                                                                                                    |
| 物理资源/回退生命周期             | 3 文件 46/46                                                    | `output/convergence-resource-lifecycle-final.log`                                                                                                                                       |
| 主进程 admission                  | 3 文件 40/40                                                    | `output/convergence-main-admission-final.log`                                                                                                                                           |
| Main 缓存重入组合                 | 3 文件 58/58                                                    | `output/display-cache-reentrancy-regression.log`                                                                                                                                        |
| renderer 重入与精确通知           | 3 文件 40/40；窄 lint 通过                                      | `output/convergence-renderer-budget-reentrancy-final.log`、`output/convergence-renderer-budget-reentrancy-lint.log`                                                                     |
| 原生准备绑定/真实消费者           | 6 文件 52/52                                                    | `output/mods-convergence-p0-20261022/display-preparation-native-r4.log`                                                                                                                 |
| 来源、匹配、watchdog/物理生命周期 | 7 文件 80/80                                                    | `output/mods-convergence-p0-20261022/display-preparation-source-security-r4.log`                                                                                                        |
| prepend helper                    | 3 文件 15/15；3 次独立 browser 为 0 empty/visible-empty frame   | `output/chat-virtual-prepend-helper-unit-final.log`、`output/chat-virtual-prepend-final-r1.log`、`output/chat-virtual-prepend-final-r2.log`、`output/chat-virtual-prepend-final-r3.log` |
| 列表修复后的完整聊天源码 browser  | 8/8 脚本 exit 0；该 fixture prepend 0 empty/visible-empty frame | `output/convergence-chat-browser-final.log`                                                                                                                                             |

源码浏览器联合回归包含 `test:chat:performance` 原 8 脚本，以及 first-paint、assistant-prefix、
message-recovery、progress-sites、tool-display-projection 和 host-message 六脚本。后六组分别
通过 5、5、37、11、8、5 个行为场景；prefix 的汇总输出不重复计数。工具与缓存重挂证据为
`output/tool-display-projection-browser/1792639163761/validation.json`，消息恢复证据为
`output/site-message-recovery-20261011/browser-1792639108293/`。

这些测试使用真实 renderer 组件、受控 IPC 回执和真实样式，不等同真实原生批准或安装包验收。
first-paint 的 CSS 在内存编译且不写应用产物；没有执行 `npm run build`。本轮与完整单元测试
存在 CPU 竞争，仅用于功能与调度回归，不用于绝对 P95。首轮虚拟列表日志记录 prepend 阶段
1 个 empty frame，随后独立定位并新增 helper 修复；最终三轮及完整 8 脚本已为该 fixture 验证零空帧。
这些结果不外推为所有数据规模、安装包或真实用户场景均无空帧。

### P0 观测脚本与新协议的对齐

合成历史脚本保留原四组 `legacy-owned` 兼容夹具，并新增 `site-read-projected` 与
`site-read-mounted`，分开记录 `siteRead`、projected/mounted outcome 及旧 mount/render/unmount
调用，不能将旧接口未调用解释为没有 guest 工作。新 projection 使用真实共享 DTO validator 与
真实组件；模拟保护仅将确定的测试 sentinel 替换为标记，包含 DOM 闪漏检查，不代表真实 Main
权限或来源证明。guest 求值、source guard 与策略调用数均为 `null`，没有以 mock 返回 0。

摘要键与输入 memo 修复冻结后，两组已各复验一次，记录为
`output/convergence-performance-bridge-source-validation.json`。projected 观察到 358 次
`siteRead`，其中 18 次 hostMessage；10000/10001/30720/65536 字符样例均验证实际读取分流、
完整尾部表格与远端引用。mounted 观察到 335 次 `siteRead`、333 次卸载；
首次 drawing 已含在 mounted 返回内，`siteRender=0` 不能推导 guest 没有绘制。调用数覆盖夹具
生命周期及长文功能预检，不是单位消息成本。正式配置的两脚本 lint 通过，记录在
`output/convergence-performance-fixture-lint-final.log`。

每组保存 esbuild 的 2662 项 metafile 输入与实际提供给 bundler 的 226 个项目源码 hash；
两组项目源码摘要均为 `d878236bc9056d0dfc5e4a6f4bf487af60a7bba24931cef969275c290b6540e4`，
且执行后逐一核对工作区字节未变。这 226 项是该合成夹具实际使用的项目依赖，不是全应用源码；
第三方及虚拟输入清单不等于全部运行库字节证明，依赖库另记 package-lock 身份。
本次两组均为当前工作区源码，`baselineCommit=null/sourceMixed=false`。仅在启用旧
`PERF_BASELINE_COMMIT` 对照选项时，才只冻结八个入口模块，报告为 `partial8/sourceMixed=true`；
该部分冻结模式不能用于正式新旧版本 A/B 放行，后续应使用完整独立源码快照。CSS 保留实际读取身份。
修复前的 225 项源码证据保留在
`output/convergence-performance-bridge-source-validation-before-digest-key.json`，仅作为历史记录，
不覆盖本次最终工作区。

最终两组存在类型检查、Lint 等并发校验负载；脚本的并发开关是人工声明，不是原生进程探针。
未执行五轮固定机器基准。首轮诊断暴露初始
`performance.now()` 与 RAF 时间戳混用导致负间隔，已保留失败日志；改为首 RAF 建立原点，
后续只计算相邻 RAF 间隔，不钳制或筛除异常样本。功能通过不代表帧耗时门槛通过。

真实 Electron 历史脚本的第三组改称 `unrelated-approved-guest`，旧参数 `guest` 仅作为兼容别名。
该组证明精确来源批准及旧接口 admission probe，不证明实际匹配 AssistantMessage 或 guest
求值次数；默认历史样例也没有覆盖 hostMessage。原生脚本只观测真实 DOM/输入/进程区间，
所有未埋点的显示与 guest 计数为 `null`，保留源码与实际 out/ASAR 身份未建立对应的说明。
本轮仅静态更新该脚本，没有运行原生应用、构建或整包测试。

边界测试解析真实静态 import/export、字面 dynamic import 与 import type 关系，验证显示模块
不依赖创造者、业务适配、设置 UI 或 renderer，也不反向引入 manager；renderer 显示模块通过
shared 使用 DTO，guest bootstrap 与 SDK 目录不暴露私有 scope/cache/rollout 生命周期。
它不执行第三方模块，不替代 runtime 权限验证，也不宣称能分析任意计算得到的导入目标。

`output/convergence-native-tests.log`、`output/convergence-display-read-r2.log`、
`output/convergence-integrated-display-r3.log`、
`output/mods-convergence-p0-20261022/display-preparation-native-final.log` 虽有 final 名称仍包含过程失败，
不能作为通过证据。P3 最终有效记录为表中的 r4 日志。
后续修复后的有效分组见上表，最终统一回归见下文。保留失败
记录用于解释问题，不通过改日志或混用旧结果获得绿色。

### 完整回归的资源调度

`vitest.config.ts` 保留原测试收集范围，将两份真实原生图集成测试
`function-conversation-native-host.test.ts` 与 `conversation-shared-native-host.test.ts`
置于 `native-integration` 项目。该项目使用 `sequence.groupOrder: 0`、
`forks.singleFork: true` 和原有文件隔离；其余测试位于 group 1，继续使用调用方指定的
并发数量。没有删除断言、增加重试或放宽原 5000ms 用例期限。独占指本次 Vitest 调度组，
不能隔离同机其他构建、浏览器或另一个测试进程的资源竞争。

新增 `tests/browser/vitest-scheduling.test.ts` 使用真实 Vitest 收集 API，逐文件对比原 include
范围，验证无遗漏和重复、精确分组、原期限与窄文件筛选。该检查只收集而不递归执行测试。
实际三文件短探针还验证了在三个 worker 及 `VITEST_MAX_FORKS=3` 环境下，两份原生文件
由同一进程依次完成，之后普通项目才启动。证据为
`output/mods-convergence-p0-20261022/vitest-scheduling-contract-env3.log` 与
`output/mods-convergence-p0-20261022/vitest-scheduling-probe/verified-env3.json`。

建议最终完整回归在无其他重负载进程时使用两个 worker，先为严格期限保留资源余量，
不把增加并发等同于缩短可靠验收时间。分组配置与短探针通过不代表完整回归通过；此前
此前全量日志中的失败仍保留；第二轮已知超时的运行在完成前停止，记录为 partial，
不是一次完整通过。最终以新调度下同一次完整命令的实际退出码为准。

### 最终统一回归与停止条件

2026-10-22 12:28:54 至 13:26:42（UTC+8），Node 22.22.2、并行组两个 worker，
运行完整 `npm test`，最终退出码 **0**。最先独占执行的两份原生集成测试 92/92 通过，
保留原有 5000ms 时限。Vitest 主体为 **1606 文件、16128 用例通过**，16 文件、84 用例
按既有条件跳过；后续 adoption、消息、Hooks、插件、任务卡、合并、workflow、桌面 Agent、
IM、流程恢复、创作预览与安装、文件恢复、两类评测及界面脚本全部通过。重复执行的小组
和独立脚本不与主体用例数累加。真实 workflow-worktree 的 66 项 Git 业务测试也已通过。

完整日志与退出回执：`output/convergence-full-regression-release-source.log`、
`output/convergence-full-regression-release-source-result.json`。
最终完整类型检查：`output/convergence-types-release-source.log`，退出码 0。
按未修改规则的正式 ESLint 配置检查全部 102 个变更/新增源码与测试文件，0 错误、5988 警告，
证据为 `output/convergence-final-changed-lint.json`。这不代表全仓库 Lint 通过；全仓库早期
记录为 172 错误、630847 警告，其中本轮测试的 1 项错误已修复，另 171 项位于未改动的 HEAD
文件，完整归因和基线审计保留。本轮没有为了绿色关闭规则或修整无关业务代码。

两项过时测试合同已更新并保留有效检查：长消息改测专用受保护 hostMessage 合同；
创作类型目录按真实分页读取，继续验证规范名称及兼容别名，不再用首屏截断内容推断缺项。
没有删除业务、来源、授权或异常恢复断言。

回归前后 4751 个源码、测试、脚本及配置文件字节一致，摘要
`f58c1280e0c74d0f9e3b3bb92e146bee01ffe1bdafe758140154c2d0e565ade0`；
对应 `output/convergence-source-freeze-before.json` 与 `output/convergence-source-freeze-after.json`。
`output/mods-convergence-p0-20261022/post-regression-source-audit.json` 的 9 项检查通过：
分支/HEAD 正确、原 24 路径补丁及 manifest 未变、所列旧输出身份未变，未新增 tracked 应用产物。
该审计仅覆盖明确列出的旧输出，不冒称整个 out/dist 目录或安装包已经验收。

当前授权源码范围至此完成并停止。本轮未构建应用、打包安装包、提交推送或触发 Actions。
P6 真实放量与下列性能门槛仍待后续授权，不能表述为全部阶段放行或卡顿已经根治。

## 5. 统计规则与未验收项目

- 合法压力规模为 400/2000/10000 条分页历史；已安装目录可有 20 个来源，但单链活跃来源上限
  仍为 8。单来源 128 个编译文件上限包含入口文件，即最多 127 个额外资源，且总源码不超 2MiB。
  非法超限应验证原有拒绝，不能当正常性能样本。
- 默认浏览器脚本不挂 CDP Profiler/Tracing；诊断 profile 与正常时间数据分别记录。
- 冷读与有效热重访、淘汰、过期、动态求值分别分类。冷读每轮至少 6 个独立 fixture，不能用
  同一会话重复重访充数；五轮每版本至少 30 个。每个 after 轮次单独达标，使用 nearest-rank。
- 请求到可用正文 DOM 的时间包含来源 guard；DOM 相交/正文存在是代理指标，不冒称像素 paint。
- CDP TaskDuration 仅代表 renderer 主线程。原生脚本新增 Electron 实际进程累计 CPU 和工作集
  区间；PID 复用、进程退出或缺字段须标不完整，worker/QuickJS 未分开归因，不以未知当零。
- 内存窗口要求至少两小时、首末各十分钟真实连续采样、相同空闲及缓存条件。renderer heap
  不能单独证明全应用无泄漏；诊断强制 GC 不混入延迟采样。

当前未验收：固定 60Hz 五轮 A/B、2000/10000 条真实原生
全链路规模、主线程长任务归因、新构建与包内矩阵、真实升级/降级和受控放量、至少两小时
浸泡及 Main/worker/QuickJS/句柄的资源回收。这些项目不能使用旧包绿色记录抵扣。

完整 `npm test`、最终 Node/Web TypeScript 与源码分组已通过，证据与基线归因见第 4 节。
整体 Lint 尚未放行，既有错误与格式警告需要另行治理；本轮没有将其计为通过。

完整方案与放行门槛见 [Mods 整体收敛与重构方案](mods-convergence-refactor-plan-2026-10-22.md)。
