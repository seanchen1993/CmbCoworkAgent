# Bot 五类性能优化与验证 · 2026-11-17

> 后续修正：用户明确要求保留高并行能力。本文第 4 项的「4 执行 + 2 沟通」方案已撤销，不能将减少实际运行任务数视作性能提升。当前生产配置恢复无 Host 总并发上限，保留线程/资源锁，通过时间片与队列索引优化调度。本文及原始数据作为历史方案保留；当前实现与完整负载复测见[调度修正记录](scheduling-correction.md)。

五类优化已落到 Bot 生产代码。任务查询按范围和有效索引读取，目录按变更范围刷新，Feature 使用游标分页与请求合并，Bot Host 分开限制执行/沟通并发，记忆内容有界缓存并提前跳过超预算序列化。最终定向 Bot 回归为 **134 个文件、2,583 条通过**；之后补齐旧数据分类兼容并再跑 270 条相关回归通过。两者有重叠，不累计成独立测试总数。

本报告是本地合成负载与实际 Renderer 组件验证，未请求真实模型、招乎或 ES。不能据此承诺内网响应耗时。优化前评审及全部旧记录保留在 [README](README.md)。

## 目的、范围与验收

用户要求把评审确认的五类问题全部优化。假设是：减少历史扫描、无关刷新、重复读取和无界接纳，可以降低主进程同步工作与 IPC 压力，同时保持任务状态、分页和会话隔离正确。

本轮修改 Bot Host/store/memory、Bot IPC/preload、Bot 面板和共享合同。没有更改普通对话/项目模式的原生执行调度，也没有改 IM 网关或 ES mapping。Bot 本地 SQLite 自动创建必要索引；定向失效表和触发器是连接级 TEMP 对象，不存聊天内容。原有文件、Git、浏览器资源锁范围保持不变。

验收不仅看耗时，还验证：

- 任务投影与优化前 SQL 的全部返回列一致，含 Team/Workflow、后台命令、等待输入、同毫秒排序及未汇总结果。
- 2,000 个任务、2,000 个 Feature 的全部游标页没有缺项、重复 ID 或重复游标；搜索与会话范围仍正确。
- 无关事件不重读任务目录；刷新和加载更多不叠加；旧范围的慢响应不覆盖新范围。
- 执行达到上限时主对话仍能取得预留名额，结束后自动补入排队工作，取消/停止仍释放租约。
- 记忆缓存不会跨 Bot/群泄露内容；外部编辑、相同大小且还原 mtime 的编辑、删除和符号链接替换均被发现；调用方不能修改缓存对象。

## 条件与复现

- 时间：2026-11-17，Asia/Shanghai 21:20–21:44；精确 UTC 时间、退出码保存在各轮 `execution.json`。
- 代码：`codex/merge-uat-into-bot-beta`，基于 `f91771b435c57c6548bb3292566161b3d7d52ef4` 的未提交差异。每轮保存变更文件 SHA-256、tracked 文件差异和新增源码副本；最终版本见[运行元数据](20261117T134329007Z-performance/execution.json)及[源码/差异](20261117T134329007Z-performance/source/)。
- 环境：Apple M2、macOS arm64、Node 22.23.5、项目安装的 Electron/Chromium。Node 使用 `node:sqlite`。
- 输入：隔离合成 Bot/任务/Feature/记忆/临时文件；不使用真实用户数据库或 Electron profile。长任务与 Feature 使用临时文件 SQLite、WAL、`synchronous=NORMAL`；其他目录/调度使用内存数据库。造数不计入查询耗时。
- 同步 API 先预热再取 7 或 9 次，正文使用中位数；原始样本及样本 p95 在 metrics。小样本 p95 接近最大值，不能视作生产 p95。序列化输出大小的测量不计入 SQL 时间。
- Renderer 使用实际 React 组件/hooks；受控 IPC 模拟普通请求 10 ms、Feature 列表/详情 600 ms。调度测试使用保持未结束的模拟 runtime 租约，没有真实模型调用。
- 修改后的 debounce 为 100/150 ms，Renderer 安静期判定从旧基线的 50 ms 提高到 200 ms，避免在延迟刷新启动前误判结束。对照只用请求次数、峰值与 `requestSpanMs`；不把含安静期的总等待直接相比。增加了突发新增、删除、完整 Feature 分页、尾部搜索和范围切换用例，旧轮次不覆盖。

在仓库根目录使用 Node 22+：

```sh
node scripts/run-bot-performance-review.mjs performance
node scripts/run-bot-performance-review.mjs renderer
node scripts/run-bot-performance-review.mjs regression
node scripts/run-bot-performance-review.mjs focused
node scripts/run-bot-performance-review.mjs directory-ui
node scripts/run-bot-performance-review.mjs feature-ui
node scripts/run-bot-performance-review.mjs typecheck-node
node scripts/run-bot-performance-review.mjs typecheck-web
```

每次生成新目录，不覆盖旧实验。不传套件时依次执行 performance、renderer、preview、regression；IM 专项可传 `im-regression`。归档包含标准输出、错误输出、退出码、环境、源码指纹和差异，个人目录/临时路径替换为占位符。未执行或失败的轮次不会算成通过。

## 实现与结果

以下基线取[优化前最终性能](20261117T124031533629Z-final-performance/metrics.json)、[优化前最终 Renderer](20261117T124226889928Z-renderer-final/metrics.json)；优化后取[最终性能](20261117T134329007Z-performance/metrics.json)、[最终 Renderer](20261117T133718174Z-renderer/metrics.json)。不跨轮平均，也不把不同版本的重复测试算作独立样本。

| 场景 | 优化前 | 优化后 | 正确性/口径 |
| --- | ---: | ---: | --- |
| 列表：5 万历史、2,000 任务、0 后台命令 | 12.77 ms | 1.47 ms | 实际 API，仍返回 22,333 B 元数据 |
| 同上，100 个 accepted 命令 | 83.41 ms，样本 p95 86.62 ms | 1.65 ms，样本 p95 1.75 ms | 3 次小范围查询；投影保持一致 |
| 上述 2,000 任务含 100 命令，全量遍历 50 页 | 2,162.80 ms | 83.51 ms | 全部任务可读，无重复/遗漏 |
| 单任务 5 万轮历史，读取任务详情 | 30.98 ms | 0.175 ms | 约 693 B 状态输出；不读会话正文 |
| Feature：2,000 项 × 50 操作历史，取 20 项 | 28.09 ms | 0.189 ms | 同一查询口径，返回 4,921 B |
| Feature：旧无限列表 vs 新 UI 首页 API | 33.20 ms / 487,591 B | 0.868 ms / 9,054 B | **不同输出范围**：新 API 为 40 项及优先项，不称为等量加速 |
| 2,000 项任务已展开，单次无关事件 | 1 snapshot + 1 list + 49 summaries | 1 snapshot；目录查询 0 | 模拟 IPC 请求跨度 685.4 → 12.0 ms |
| 10 次 Feature 事件，每次列表/详情读取 600 ms | 列表 10 + 详情 10；峰值 8 | 列表 4 + 详情 4；峰值 2 | 每类最多 1 个在途，变更合并后最终版本正确 |
| 200 个大记忆文件，总 936 万字符，完整提示准备 | 35.77 ms | 缓存热读 0.785 ms；冷读 10.182 ms | 热读为中位数，冷读单次；最终提示均 1,461 B |

### 1. 任务 SQL

[store.ts](../../../src/main/bots/store.ts) 把有/无 audience 的谓词分开；目录可直接使用 Bot/会话/ordinal 索引。执行状态先查小范围活跃记录，再按时间索引回退到最新直接任务；未汇总结果使用独立 partial index。后台命令和有效 Workflow 归属先形成集合，避免为每条目录记录扫描全部历史。

为活跃任务、结果排序、命令来源、有效 Workflow 建索引，保留原有历史与权限语义。[投影回归](../../../src/main/bots/work-projection.test.ts) 对照的是基线 SQL 的真实列值，不只是行数；[性能回归](../../../src/main/bots/performance-regression.test.ts) 验证查询计划不再对操作历史做临时分类排序。

### 2. 按范围刷新任务

[work-invalidation.ts](../../../src/main/bots/work-invalidation.ts) 用连接内变更日志收集任务、活动、命令和 Workflow 变化，随事务一起回滚。事件只携带 Bot、会话和任务 ID；同一作用域超过 200 个变化时发送明确的分页重置标志，避免大事件载荷，不截断历史数据。

[use-bot-works.ts](../../../src/renderer/src/components/bots/use-bot-works.ts) 合并 100 ms 内变化，串行刷新首屏/优先项及变化 ID，每批摘要最多 40。已展开历史按 ID Map 合并，常规事件不重新扫描；显式刷新/窗口重新聚焦仍能核验已加载目录。浏览器接管状态也会标记所属任务，避免只盯数据库状态而漏掉本地运行变化。

实际 Renderer 验证：一个首屏外任务更新仅产生 1 次 list + 1 次 summaries（1 个 ID）；删除后 1,999 项；历史全展开后一次新增 45 项，最终 **2,044 项**且无重复，首屏以外只补读 5 项。修复了这一突发场景原本可能丢掉新任务的边界。老 host 没有范围事件时仍支持 revision 回退刷新。

### 3. Feature 分页和请求合并

[feature-store.ts](../../../src/main/bots/feature-store.ts) 用四类索引候选保留原优先级：活跃且有决策、任何决策、活跃操作、最新操作；不再对每个 Feature 的全部操作历史分类排序。新 `bots:feature:page` 使用作用域绑定的稳定游标，首屏最多 40 项、优先项 6 项、变更补读最多 40 项。当前 UI 改用分页；旧 list API 仅为兼容保留。选择器通过项目内的关联 slug 集合判断是否已绑定，不依赖已经加载了哪些页。

[use-bot-refresh.ts](../../../src/renderer/src/components/bots/use-bot-refresh.ts) 保持同类请求单飞，变化期间只合并下一轮刷新；切换 Bot/群/搜索后忽略旧响应。列表和详情各自最多一个请求，详情只在打开时保留原有轮询。超过 40 个 Feature 变更或无精确范围的事件显式重新分页。

实际 API 完整遍历 2,000 个 Feature、50 页耗时 **40.94 ms**，无遗漏/重复。实际 Renderer 验证 130 项跨页读取、尾部搜索、慢请求期间切群且旧响应不能污染新范围；旧客户端的 Feature 关联交互也通过。

### 4. 执行并发与沟通预留

[当时的 admission.ts 源码](20261117T134329007Z-performance/source/src/main/bots/admission.ts) 的生产策略为 **4 个执行名额 + 2 个沟通名额**。SQL 队列分类与提示角色判定一致，覆盖历史 null origin 数据。每轮接纳最多启动 4 个租约或使用 8 ms 后通过 `setImmediate` 让出事件循环；租约释放后继续补入。资源锁仍按原文件/浏览器范围执行，没有扩大成所有任务共用一把锁。

500 个保持运行的模拟独立任务：旧策略同时 active 500；新策略 active **4**、queued **496**。额外主对话 ping 可以获得沟通名额，观测调度 3.743 ms；测试总峰值 5（4 执行 + 1 ping）。取消后租约释放，定向回归验证空槽自动补入。

这验证的是接纳上限与沟通隔离，**不是 500 件工作全部执行完的吞吐加速**。新策略接纳本次可运行的 4 件工作为 8.589 ms，不能与旧策略启动 500 件工作的 648.56 ms 当作等量比较。该测试的 ping 在首批接纳后提交，不证明真实模型首 token 或任意高负载下的延迟。等待用户的活跃 runtime 仍占名额；原有排队上限 500 未变。策略只约束 Bot Host runtime，不对普通对话和原生项目执行器新增全局限流。

### 5. 记忆准备

[memory.ts](../../../src/main/bots/memory.ts) 采用 **24 MiB 估算字节预算**的 LRU。每轮仍校验目录、文件名、文件类型、大小及 dev/ino/mtime/ctime；文件身份没变才复用内容与解析结果。可见性始终按调用范围重新过滤；返回对象及 scope 都复制。删除 Bot/服务关闭释放缓存；外部同大小修改即使还原 mtime，也能由 ctime 发现。

[prompt.ts](../../../src/main/bots/prompt.ts) 在 JSON 序列化前先跳过肯定超预算的内容，保持后续小记忆可入提示、字符转义和省略计数。没有降低安全校验或把未读取内容当成已读取。

大文件实验中每条都超过 4,000 字符预算，最终没有记忆正文，只有规则/省略提示。它证明超预算内容不应反复消耗读取/序列化时间，**不能代表记忆召回质量**。24 MiB 是缓存内容估算上限，不是进程 RSS 承诺；首次读取仍有同步 I/O。

## 全部优化轮次与失败记录

旧评审 11 轮记录继续保留；本轮新增以下 19 轮。测试标准、夹具或代码错误都明确记载，失败轮次不计通过。

| 轮次 | 结果与处理 |
| --- | --- |
| [132036 focused](20261117T132036384Z-focused/output.txt) | 218 通过、13 失败。触发器内 OR REPLACE 受外层 UPSERT 冲突策略影响；改为显式 ON CONFLICT DO UPDATE 并补事务/UPSERT 回归。另有事件结构新增字段导致旧精确断言不匹配，更新预期。 |
| [132046 node 类型](20261117T132046088Z-typecheck-node/execution.json) | 退出 0；这一阶段的类型检查。 |
| [132046 web 类型](20261117T132046088Z-typecheck-web/output.txt) | 退出 2；useRef 初始化/undefined 类型不完整，修复。 |
| [132201 focused](20261117T132201071Z-focused/output.txt) | 261 通过、1 失败；旧 Workflow 索引名的计划断言过时，改为新 partial index 并保留基线 SQL 列值对照。 |
| [132418 Renderer](20261117T132418632Z-renderer/execution.json) | 退出 0，首轮范围刷新和请求合并界面验证；不是最终观测。 |
| [132503 focused](20261117T132503475Z-focused/output.txt) | 6 文件、270 通过。 |
| [132559 性能](20261117T132559978Z-performance/metrics.json) | 79 组观测，退出 0；中间结果保留，正文采用后面的最终版本。 |
| [132926 完整 Bot 回归](20261117T132926699Z-regression/output.txt) | 2,580 通过、3 失败。旧 schema 模拟夹具需先删除新索引/TEMP 触发器才能删列；表情事件精确预期需包含 workChanges。另一次 IM 附件测试超过 5 秒，未证明是生产故障，也不声称已定位其根因；后续专项与完整套件均通过。 |
| [133245 IM 专项](20261117T133245736Z-im-regression/output.txt) | 3 文件、183 通过，包含前述附件用例；模拟网关而非真实招乎。 |
| [133315 Feature UI](20261117T133315870Z-feature-ui/output.txt) | 退出 0，实际 Renderer 中关联/操作交互通过。 |
| [133315 任务目录 UI](20261117T133315871Z-directory-ui/output.txt) | 退出 1；旧 fixture 缺少 BotClient 必需的 subscribe，造成页面异常/超时；补夹具 no-op 订阅。 |
| [133544 任务目录 UI](20261117T133544226Z-directory-ui/output.txt) | 退出 0；加载更多、搜索、错误恢复、晚到响应和切换 Bot 通过。 |
| [133544 node 类型](20261117T133544226Z-typecheck-node/output.txt) | 退出 2；新增测试 spy 的 SQL bindings 类型过窄，按 NativeSqliteBindings 修正。 |
| [133544 web 类型](20261117T133544226Z-typecheck-web/execution.json) | 退出 0，最终前端生产代码类型检查。 |
| [133718 最终 Renderer](20261117T133718174Z-renderer/metrics.json) | 退出 0；9 组请求观测，另含完整 Feature 分页/尾部搜索/慢请求切换的正确性断言。 |
| [133844 完整 Bot 回归](20261117T133844258Z-regression/output.txt) | **134 文件、2,583 通过**；Vitest 113.87 秒。这是 Bot 定向大套件，不是全仓所有测试。 |
| [134200 focused](20261117T134200453Z-focused/output.txt) | 最后补齐 IM null origin 分类兼容及缓存 scope 对象隔离后，6 文件、270 通过，17.84 秒；与完整套件重叠。 |
| [134214 node 类型](20261117T134214026Z-typecheck-node/execution.json) | 退出 0，最终 Node 生产代码/测试类型检查。 |
| [134329 最终性能](20261117T134329007Z-performance/metrics.json) | **87 组观测，退出 0**；新增实际 Feature 分页 API/完整遍历、记忆冷读，使用最终源码。 |

## 结论边界与内网待验证项

五类结构性问题已优化，最终本地断言和类型检查通过。附件、技能传递、Steer、结果排队、Feature/Team/Workflow、消息权限、浏览器接管、文件锁、埋点和 ES 查询形状包含在定向回归/性能守护中；没有为这些链路另改业务语义。

仍需内网观测：真实模型 TTFT/缓存命中、多个执行任务与用户等待同时存在时的调度体验、Windows 真实磁盘/杀毒软件开销、旧大数据库首次建索引时间、长期内存/磁盘曲线、真实招乎上传与最终回执、ES 分片和多用户看板压力。本轮未做这些测试，缺测不算通过。附件跨群吞吐/长期快照回收属于上轮已标明的后续专项，不属于本次五类修改。
