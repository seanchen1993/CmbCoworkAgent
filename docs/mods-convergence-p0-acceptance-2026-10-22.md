# P0 决策、安全矩阵与验收记录

> 后续复检：下述完整绿色记录属于审查修复之前的源码。当前四项修复及其验证状态以
> [修复与复审记录](mods-review-fixes-2026-10-22.md) 为准，整体性能与整包验收仍未完成。

日期：2026-10-22。分支：`codex/mods-v2`。这是实施记录，不是整包性能通过证明。

最终冻结回归：完整 `npm test` 退出码 0，Vitest 主体 1606 文件、16128 用例通过，
16 文件、84 用例按既有条件跳过，后续独立脚本全部通过。Node/Web TypeScript 通过；
正式配置下 102 个变更文件 Lint 为 0 错误、5988 警告，整体 Lint 仍有既有错误。
回归前后 4751 个源码/测试/脚本/配置文件哈希一致，未构建应用或触发 Actions。
完整日志为 `output/convergence-full-regression-release-source.log`，
命令退出回执为 `output/convergence-full-regression-release-source-result.json`；
更多边界与归因见 [最终实施记录](mods-convergence-implementation-2026-10-22.md)。

## 初始身份

初始 manifest：`output/mods-convergence-p0-20261022/baseline-manifest.json`。
HEAD：`403affb132e74a2e63bc1b51deab5fad384b7803`。
原始 HEAD 二进制 diff SHA256：
`822f5a067f1d38985d2b61395276aba24a1a7cd091f4b9774895b62ad2969c9e`。
捕获前后身份一致；后续文件变化不能覆盖这份基线。初次仅存 diff hash，后续按保留的 24 个
公开 tracked 路径重新生成二进制 diff，确认 SHA256 和 62856 字节完全一致后，才保存 ignored 的
`output/mods-convergence-p0-20261022/original-baseline.patch` 与独立 `baseline-reproduction.json`。
未改原始 manifest、未应用补丁，未读取用户报告、敏感配置或未知未跟踪文档。

Node 为现有安装的 22.22.2，npm 10.9.7，锁定 Electron 39.8.10。
系统默认 Node 24 不作为本轮测试环境。主机只记录匿名 hash、CPU/内存/系统和电源方案；
显示适配器报告 144Hz，因此目前不是固定 60Hz 计时放行环境。
manifest 中既有 `out/` 或 `dist/` 只证明原文件身份，不代表本轮源码已经构建。

旧 renderer 诊断与 manager 成本 JSON 已索引到
`output/mods-convergence-p0-20261022/baseline-evidence-index.json`。
旧 renderer 自带八源码及 CSS hash，但始终开 CPU Profiler/Tracing，不能当无调试时间基准。
旧 manager JSON 无 source hash，明确标为历史未绑定数据。本轮窄诊断 3/3 通过，结果另存
`manager-baseline/`；选定 manager/来源守卫/测试入口捕获前后 hash 一致。它是单轮成本诊断，
不代表五轮统计或整包性能门槛通过，完整传递依赖身份仍以初始工作区 manifest 为背景。

## ADR：保守路由、非权威缓存与安全复核

1. 只有可以证明无匹配的组件才走宿主路径；动态/未知 matcher 保留原兼容管线。
2. 静态展示快照是非权威缓存，依赖 message/scope/source/policy/version 的有效性；
   过期、容量淘汰、状态读取或交互行为不满足证明时回退，不用双跑副作用绘制来比较结果。
3. 必要 source guard 始终执行并计入端到端可读耗时。guard 归因允许单列，不允许扣除。
4. 源码变化、撤权、scope/actor 改变立即拒绝旧权限。展示缓存不保存有效交互授权。
5. 原插件/平台 authority 不变；本轮不新增业务状态引擎，不把 DOM 生命周期当执行提交。
6. 回退先停止新租约并失效旧回包；未知动作不自动重播，物理任务未结束不虚构清理完成。

## 能力与安全矩阵

| 能力                         | 已有基础/保留契约                                  | 新实现放行条件                                            | 当前验收层级                                                                             |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 无正文 Mod 宿主安全显示      | `host-only-sites`、原 output policy                | 保护开启与关闭分别测；无匹配新增 guest=0                  | 路由/成本分组 31/31；真实安装包待验收                                                    |
| 静态快照与逐 key 失效        | 原 named-state 读引擎、thread-state、展示/队列基础 | source/policy/scope 有效；缓存预算；旧 action 不复活      | 主进程 admission 40/40、renderer 重入/缓存/scope 40/40；冻结变更 369/369，长期验收未完成 |
| 动态 matcher/状态读取/Client | 原 guest、owner、交互管线                          | 不改变动态调用与读集合语义；未知走保守路径                | 兼容性回归，不能冒称零求值                                                               |
| 来源即时复核                 | `source-adoption-fence` 与来源竞态测试             | 改字节/替换文件/撤权均拒绝旧 owner；统计包含 guard        | 原契约不可因性能删减                                                                     |
| 工具与公开动作               | 真实批准、持久 intent/unknown 日志                 | 旧源码不能借新源码身份核对成功；未知不重播                | 既有 `platform-action-persistence.test.ts`                                               |
| 队列/取消/物理进程           | 既有物理完成回执与额度                             | 1 在途+1 最新；取消不伪称已退出                           | 原生与包内回归分层                                                                       |
| Markdown/长文本              | 完成态 parser 与保护/sanitize；宿主长消息专用 DTO  | 完成态 oracle；跨段语义不确定走原路径；guest 输入限额不变 | 局部单元 26/26；长消息浏览器 5 场景通过；无整包吞吐结论                                  |
| 新旧路径回退                 | 原来源/动作恢复套件                                | 真正切换时无双执行、旧批准不复活；不混用 DTO              | 新适配器/安装包演练尚未验收                                                              |

矩阵列为实施门槛，不能把“已有基础”读成新架构已经完成。具体执行证据由各阶段补充。

## 六项评审补充的执行口径

下表核对安全与验收协议，不把实现模块数量或局部测试通过当作 P0—P6 全部完成。

| 补充项                                  | 本轮明确的契约与已落实现                                                                                                                                                                                                         | 证据与限制                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生数据库与 thread incarnation scope   | `display-scopes.ts` 使用真实数据库对象身份、规范工作区与宿主 ThreadIncarnation，并保留 assertCurrent；renderer 仅获得 opaque scope token。相同 thread 字符串不能跨数据库、删除重建或原生执行身份复用快照                         | 主缓存、scope 与投影组有对应反例；普通无持久子会话身份不能伪造数据库行，未证明的路径继续兼容处理或拒绝                                                                                  |
| 依赖原子交接                            | 从原 named-state readers 捕获当前 coherent 的实际读集合，在旧 generation 释放前同步检查版本与字面 ref 覆盖；缺失键 version 0 也要真实读过。展示 proof 接管同一引擎订阅并计原额度；handoff 后释放 owner，await 后再核对 row/proof | `named-state.test.ts`、`named-state-projection.test.ts`、`display-read.integration.test.ts`；失效、淘汰或来源改变后释放 proof，不采用两次分离读取间“默认未变化”的假定                   |
| 被动 frame 与真实交互租约               | 纯数据不得携带 owner、generation、Client、handle 或 Markdown action sidecar；缓存只读。当前 ToolUse/ToolResult/ToolGroup/CommandOutput 可使用真实稳定显示 ID，审批仍由原宿主入口处理；不能证明纯度时保留真实 owner               | 工具展示浏览器 8 场景通过；长消息 DTO 不扩大 guest 上限；不是对任意第三方回调的原生批准验收                                                                                             |
| 合法压力规模与真实 quota                | 合法同链活跃来源仍为 8，单来源编译文件 128（含入口）且源码不超 2MiB。Main 展示预算 14MiB，每 renderer 的所有 provider 共享 2MiB，计被动数据和缓存元数据；每 scope 96 条/单条 128KiB/120 秒                                       | renderer 多实例 LRU、精确通知、释放与元数据压力回归通过；多个窗口不合称全应用固定 16MiB。HostDisplayRollout 已对包含同键 waiter 的物理读总量实施 256 硬限，仅物理结束释放；资源组 46/46 |
| 包含 guard 的统计、进程内存与独立冷样本 | 端到端耗时包含 source guard；单列 renderer TaskDuration 与实际 Electron 进程 CPU/工作集，不将缺失归因当零。固定 60Hz，逐 after 轮达标，至少五轮、每轮至少六个独立冷 fixture；GC 诊断不混入延迟采样                               | 原规则测试 9/9；当前 144Hz、并发测试及带 profile 的旧输出均不能放行。2000/10000 真实链路和两小时多进程资源回收待验收                                                                    |
| 在途回退与 unknown 不重播               | rollout 先停 admission、提升 epoch、拒绝旧回包；旧物理工作仍在途时继续计费，直至实际结束。展示刷新不重播工具或业务提交，unknown 不改为成功                                                                                       | rollout 生命周期 11/11、源码恢复/工具浏览器通过；真实安装包切换、待确认动作与物理任务在途的升级/降级演练未验收                                                                          |

原方案 3.2/P2 已明确原生 DB/thread incarnation、依赖原子 handoff 及进程预算边界；上表将
六项约束映射到本轮实际实现和验收。不能仅依赖 workspace/thread 文本或 source/runtime
incarnation 替代原生作用域，源码回归不扩大业务 authority。

## 新增实现与当前有效证据

- **显示路由与旧来源兼容：** `output/mods-convergence-p0-20261022/display-routing-manager.log`
  为 3 文件 31/31；动态 retained AbovePrompt 来源仍走真实 owner，未改成虚假的静态无匹配。
- **主缓存与生命周期：** `output/convergence-cache-lifecycle-final.log` 为 3 文件 40/40；
  `output/convergence-cold-read-singleflight.log` 为 2 文件 37/37，包含真实 guest 同键冷读合并。
  各 waiter 在 producer 完成后独立复核来源/权限，仅复用缓存数据，不共享交互 owner。
- **renderer 缓存：** 本轮 Node 22 双 worker 的 presentation/projection/scope 3 文件 40/40；
  新全局预算记录使用 WeakRef，FinalizationRegistry 只保留 token；scope 主动失效释放记录。
  该回归验证额度与释放行为，不单凭此宣称经过两小时后不存在全应用资源泄漏。
- **Markdown：** `output/p4-markdown-geometry-unit-final.log` 为 5 文件 26/26；完成态 AST
  与安全前导代码围栏优化保留原清洗和新鲜工作区回调。相关浏览器输出见实施记录。
- **源码浏览器联合回归：** `output/convergence-browser-regression.log`，14/14 脚本 exit 0。
  原聊天 8 脚本后，first-paint/prefix/recovery/progress/tools/host-message 六组分别通过
  5/5/37/11/8/5 个命名行为场景，共 71 个，不重复计 prefix 汇总行。测试真实 React 组件和
  受控 IPC 回执，不等同完整原生批准或生产包测试；没有构建应用，CSS 仅在内存生成。

阶段冻结的 30 个变更测试文件 369/369、完整 Node/Web TypeScript 已通过；最终完整 `npm test`
也已通过，见文首及实施记录。整体 Lint 已完成基线归因，仍不能标通过。原生 load 准备通道与能力
目录实际消费者已接入，r4 的 native 组 52/52、来源/物理安全组 80/80 通过。各分组有重叠，
不相加冒称独立总用例数；过程失败日志保留，不以名称中的 final 认定成功。

源码联合回归与其他测试存在 CPU 竞争，不采纳其耗时为固定机器门槛。原虚拟列表观察器在
prepend 阶段曾记录 1 个 empty frame；新增实际 DOM prepend 视觉事务 helper 后，15/15 单元、
三次独立浏览器与最终完整 8 脚本均在该 fixture 验证 0 empty/visible-empty frame。首轮记录保留，
不外推所有数据规模或新包场景均零空帧。

阶段性源码分组证据（各组重叠，最终冻结结果见文首）：

| 范围                            | 结果                           | 记录                                                                                                                                                                                    |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 冻结变更集                      | 30 文件 369/369                | `output/convergence-changed-tests-final.log`                                                                                                                                            |
| 完整 Node/Web TypeScript        | 通过                           | `output/convergence-types-final.log`                                                                                                                                                    |
| 物理资源与生命周期/主 admission | 46/46、40/40                   | `output/convergence-resource-lifecycle-final.log`、`output/convergence-main-admission-final.log`                                                                                        |
| Main/renderer 缓存重入          | 58/58、40/40                   | `output/display-cache-reentrancy-regression.log`、`output/convergence-renderer-budget-reentrancy-final.log`                                                                             |
| P3 原生准备/来源安全            | 52/52、80/80                   | `output/mods-convergence-p0-20261022/display-preparation-native-r4.log`、`output/mods-convergence-p0-20261022/display-preparation-source-security-r4.log`                               |
| prepend                         | 15/15；3 次独立 browser 零空帧 | `output/chat-virtual-prepend-helper-unit-final.log`、`output/chat-virtual-prepend-final-r1.log`、`output/chat-virtual-prepend-final-r2.log`、`output/chat-virtual-prepend-final-r3.log` |
| 修复后完整聊天源码 browser      | 8/8 脚本 exit 0                | `output/convergence-chat-browser-final.log`                                                                                                                                             |

两端缓存淘汰/清理观察者期间拒绝同步写回；局部记录即使被回调失效也不留下 phantom 预算，
renderer 精确通知在递归失效中保持每个订阅至多一次。该回归只证明特定资源/重入契约，
不替代两小时多进程泄漏验收。原生准备结果由真实 RuntimeClient 的 load 交换绑定 physical
lifetime、runtimeId 和源码/注册摘要，最终 source guard 仍在 Main；任意 JSON/旧 peer 不获得
摘要证明。`developmentCatalog().hostDisplay` 消费统一路由能力说明，并有实际消费者回归。

## 测量工具与规则

- `tests/chat-interaction-performance.spec.ts` 默认不开 CDP Profiler/Tracing。
  `PERF_PROFILE=1` 仅诊断；`PERF_REACT_PROFILE=1` 或 `PERF_DIAGNOSTIC=1` 同样排除计时放行。
  `PERF_HISTORY_MESSAGES` 支持 400/2000/10000；使用已存在 CSS 时报告真实 hash，不隐式构建。
  四组旧桥夹具明确标为 `legacy-owned`；另有 `mods-site-read-projected` 和
  `mods-site-read-mounted`，可通过 `PERF_SCENARIO` 单独选择，实际统计新读取与返回种类。
  共享 DTO 校验和真实 DOM 仍不构成 Main 的真实性证明：模拟保护有明确标识，guest/source
  guard/策略计数均为 `null`。projected 夹具包含 10000/10001/30720/65536 字符完整样例；
  mounted 夹具保持原 guest 上限，不伪造长文 owner。
  摘要键与输入 memo 修复冻结后，最终两组分别记录 358 次读取/358 次 projected
  （其中 18 次 hostMessage）及 335 次读取/335 次 mounted、333 次卸载；
  旧 render 未调用不代表 guest 未执行。
  记录见 `output/convergence-performance-bridge-source-validation.json`。
  逐组保留 2662 项 esbuild metafile 输入、226 项实际 served 项目源码 hash 与 package-lock 身份。
  该范围是合成夹具的实际依赖，不代表全应用源码或全部运行库字节；两组项目源码摘要相同。
  修复前 225 项源码的汇总保留为
  `output/convergence-performance-bridge-source-validation-before-digest-key.json`，不作为当前源码证据。
  本次为当前工作区，`baselineCommit=null/sourceMixed=false`。启用 `PERF_BASELINE_COMMIT` 时
  仅冻结原八模块，才记为 `partial8/sourceMixed=true`，不能放行正式 A/B。
  `PERF_CONCURRENT_TEST_LOAD=1` 标明存在并发测试负载，本次结果仅作源功能/协议验证。
- `tests/chat-history-interaction-e2e.spec.ts` 记录独立冷读、真实分页/原生滚动条，支持同三种规模。
  `CHAT_HISTORY_REPETITIONS` 每轮创建新私有 fixture；重复运行本身不代表满足交替 A/B、60Hz 或
  30 个独立冷读要求。原粗粒度功能断言保留，原生可读使用 DOM 正文相交，不冒称像素 paint。
  第三组名为 `unrelated-approved-guest`，保留旧 `guest` 参数兼容；批准的 Pane 示例不等于
  匹配 AssistantMessage 绘制。显示接口调用、guest 求值及 guard 分项未埋点，统一记 `null`，
  不以旧 mount/render preflight 冒称生产 siteRead 性能或零求值。本轮没有运行此原生脚本。
- 真实脚本记录 Electron 报告的进程 CPU 累计秒/工作集及 pid+creationTime。
  进程退出、替换或缺字段时区间不完整，不把未知当零；worker 线程和 QuickJS/WASM 未单独归因。
  CDP TaskDuration 仅是 renderer 主线程，不能据此宣称总应用 CPU 降低。
- `tests/support/performance-acceptance.ts` 固定 nearest-rank、逐 after 轮通过、独立冷读样本、
  合法 8 活跃来源/128 编译文件（含 entry）/2MiB 上限和待授权发布状态。20 已安装不等于20 活跃。
- 内存浸泡要在相同空闲/缓存状态下比首末各十分钟，并核对 Main/guest/句柄；单 renderer heap
  不证明无泄漏。强制 GC 另开诊断轮，不混入延迟数据。

窄测试命令（Node 22，两个 worker）：

```powershell
node node_modules/vitest/vitest.mjs run tests/browser/performance-acceptance.test.ts --maxWorkers=2 --minWorkers=2
node node_modules/vitest/vitest.mjs run src/main/mods/v2/runtime-source-site-cost.integration.test.ts --maxWorkers=2 --minWorkers=2
```

本轮不构建、不打包、不推送或触发 Actions。P6 整包放行、五轮固定机器 A/B、2 小时浸泡及
实际升级/降级/适配器切换演练均未运行，保持待授权/待验收，不使用旧包绿色替代。

本组实际结果：Node 22 双 worker 的既有 manager 成本诊断 3/3、新统计规则回归 9/9 通过；
四个变更 TypeScript 文件 ESLint 与语法解析检查通过。日志分别为上述 output 目录中的
`manager-baseline.log`、`acceptance-unit-final.log`、`acceptance-lint-final.log` 和
`script-syntax-check.json`。语法检查只解析源文件，不执行原生历史脚本，也不构建应用。
