以下结论区分已落地的最小简化、仍必要的生命周期保护与尚未完成的最终验收。对照基线为 `origin/uat-without-mods`；不把“少一个函数、Map 或文件”当成性能收益。

1. **普通会话不承担额外 canonical 恢复工作。** `src/main/ipc/canonical-checkpoint-bootstrap.ts` 的 `readCanonicalCheckpointBootstrap` 先按真实 thread/incarnation 查询 receipt；未命中时直接返回，不启动 runtime/tuple Worker，也不尝试 canonical membership 恢复。`src/main/checkpointer/runtime-projection-store.ts` 的 `readLatestCheckpointTuple` 保留普通实际 checkpoint 的原读取路径，不能把未知、损坏或 orphan native 标记降成 ordinary。这里的“0 work”指额外 canonical 工作，不是普通历史零 SQL、零 IPC 或零 Worker。证据为 `architecture-ordinary-bootstrap-red-r1.log` 与 `architecture-ordinary-bootstrap-green-r1.log`：原定向反例关闭后六文件 113 项通过；不是当前所有新集成字节的最终全仓结果。

2. **删除可证明重复的 UI 热路径工作。** `src/renderer/src/lib/thread-context.tsx` 的 `stopDirectory` 订阅只在 `threads/currentThreadId/accountRevision` 变化时执行 `reconcileDirectory`；其他 store 通知仍 `wake`，首次 setup、新 resident 和新 missing-source marker 仍显式协调。实际目录写入均用新数组发布，不靠忽略同数组的非法原地修改获得性能。`src/renderer/src/lib/function-site-transition.ts` 的 `retainsFunctionSitePresentation` 复用与当前事实快照配对的 exact input key，省掉重复 whole-next `JSON.stringify`，没有再建 memo/cache。render、captured IPC 与 committed callback 分别使用自己的 key；原 parse、全部 facts、prefix、ticket、epoch 与 ABA 检查保留。`architecture-renderer-simplification-unit-r1.log` 的 48 项及六个串行浏览器套件均通过：1000 次无关通知为 0 次目录遍历并保留 1000 次 wake；100k 正文的十次关系检查中 whole-next stringify 从旧三参数路径的十次降到零。该计数不表示 JSON.parse、必要输入序列化或整应用耗时降到零；浏览器套件的 IPC 为受控叶子，不能替代最终 Electron 性能门槛。

3. **去掉不对应实际可达回调的重复 Main 全局 identity 轮询。** `src/main/services/thread-incarnation.ts` 的 `readThreadIncarnationToken` 使用固定捕获的 parser、Array/own-data 解释，撤销死的 `originalMetadataInterpretation` 导出。`src/main/db/native-read-dispatch.ts` 的 `originalCurrentDispatch` 与 `src/main/db/function-conversation-store.ts` 的 `joinedCurrentTarget` 不再每次重验整片无关的 Object/JSON/Number/Reflect/RegExp 原型环境。这里的轮询指每次热读重复的 identity 检查，不是已删除了某个后台定时器。实际 NativeAdapter、DatabaseSync/Statement 方法 override、Proxy/native field、关闭状态、DB generation、incarnation、源与原子 join 仍检查；尤其保留实际执行 `instanceof Uint8Array` 的 operand/constructor/`Symbol.hasInstance` 回调反例。此项窄批没有改 NativeAdapter 原 handle-origin block；后续灾难清理的单连接 unusable 改动是另一个批次，不能声称该文件最终始终未变。证据为 `architecture-global-capture-combined-r2.log` 的七文件 211 项、此前六文件 130 项及 `architecture-intrinsic-guard-probe-r1/r2`。同源 10k 次 Store 方法微测为 317.947→248.854ms，只反映该方法成本，不能写成聊天或全应用提速 21.7%。

4. **撤回旧历史导入的 V2 spool/jobs 持久化体系。** `withdrawn-c07-v2-draft/manifest.json` 保留撤回草稿的源哈希；`legacy-transcript-spool.ts`、`legacy-transcript-writer-schema.ts` 等不在当前 stage 实现中。当前保留原 V1 `legacy_checkpoint_transcript_migrations`，没有因 Mods 必须引入新消息格式、持久 job、spool 或导入 triggers。`src/main/checkpointer/runtime-projection-store.ts` 的 `prepareLegacyCheckpointTranscriptSource` 让旧 sync wrapper 与新 Worker driver 共用一次 source pin、分类、hydrate 与规范化；生产异步路径的完整数组留在 Worker；旧同步兼容入口仍存在，不声称整个代码库从不在 Main 处理数组。部分导入只允许原 marker 指向的实际 checkpoint/namespace/chain；源丢失不猜新 summary、不再次 shift。complete 源已裁剪或当前 native owner 时仅读 bounded runtime，时间补全继续 pending。真实 SQLite 证据为 `architecture-legacy-v1-pointer-red-r1.log` 的六场业务失败与 `architecture-legacy-v1-pointer-green-r1.log` 的 17 项通过；原 64/180 续传 116 条，总行 181、live-tail ordinal 保持 180。该结果覆盖共享准备及旧 sync 路径，不冒充新 Main-port 真 Worker 集成验收。

5. **统一 AppDB 写入所有者，仍诚实保留一次性 SQL 成本边界。** `src/main/checkpointer/legacy-transcript-main-writer.ts` 的 `createLegacyTranscriptWriter`、`handleLegacyTranscriptWriterCommand`、`transaction`、`apply` 与 `src/main/checkpointer/legacy-transcript-worker-driver.ts` 的 `LegacyTranscriptWorkerDriver` 使用固定 V1 通道：Worker 准备有界数据，Main 在原连接逐事务核实际 scope/noNativeOwner 后执行 reserve/copy/finish/timing。这样移除 Worker 持有 AppDB 写事务、Main 另连接同步等待该锁的争写路径；不是把任意 SQL 暴露成通用 RPC。原 `apply` 的 reserve 仍有一次性的 `UPDATE thread_messages SET ordinal=ordinal+?`，64 行/字节批预算不能证明这条全表更新也有界。旧 UAT probe 的 10k/80MiB 首次 reservation 为约 611.8ms、争锁 Main write 约 551.5ms；这些是原机制证据，不是当前版本性能数字。当前真 Worker/Main-port、异常 drain 与压力回归已通过。`legacy-v1-mainport-final-wal-KFqsiY/result.json` 中，10k 小行 Main tick 最大43.22ms；78.125MiB既有target为492.39ms，reserve466.32ms。WAL政策只在原同连接reserve生命周期调整并恢复，后台PASSIVE不保证truncate；仍不能仅凭单writer宣称Main无同步停顿。

必要保留的保护不属于可机械删除的过度设计：`captureThreadIncarnation/matchesThreadIncarnation` 区分同 ID 重建；`checkpoint-database-identity.ts` 的 path/file pin 与 `checkpoint-database-admission.ts` 的实际 lease/ref-drain 区分真实文件和物理生命周期；`runtime-projection-client.ts` 的 request/`finishPhysical`/`close` 在取消、import/factory await、返回和真实 exit 边界防 ABA、越预算与旧文件读取。`runtime-projection-client-import-identity.test.ts` 专门保留 held import 期间 rename→新 inode 的反例，实际 private actor 不 mock，ControlledWorker 仅传输；此类测试不能当成真 OS Worker 的端到端证明。

B2 的 `src/main/checkpointer/function-conversation-compaction-journal.ts` 中 `FunctionConversationCompactionJournal.prepare/advanceInsideTransaction` 处理主动压缩的 checkpoint COMMIT、delivery ACK 与控制账本跨存储中断；它不是刚撤回的旧历史 V2 导入 job。真实 SDK/OS crash 反例证明需要该 journal 和原 SQL staging，不能为减少状态而删除，也不能将其推广给所有普通写入。保留源 incarnation/file pin、私有 proof、COMMIT/ACK 阶段与真实物理完成，才允许讨论更高层简化。

R14 已核对交付与 Stage 的 6567 项受控文件。C8 通过普通和启用 Mods 各 18 轮 rich SSE，切换 p95/最大值为 436/446ms 与 668/678ms，两组均为零采样 post-ready blank。原 1500ms 门槛约束 p95。万条历史三模式各三次、1.5.5 与 1.5.12 升级和 fork、真实 IPC fork、原始 32 项聊天专项均通过。较早完整 npm test r4 已实际退出 1。最新候选各门槛与完整结果，以及 C6、C7 和旧完整回归 r1 的失败证据，见[整改报告](./mods-v2-performance-remediation-2026-11-09.md)。

最新简化仍使用现有入口和额度。

- 删除 Main 已验证路径上的重复存在性探测，保留文件身份、真实来源和符号链接校验。Claw 当前 scope 读取复用同一次真实选择，保留 legacy Boolean 回调契约。暖站点存在性检查在本次新鲜注册表中先实查合格的已加载来源。它只改变探测顺序；完整加载、来源核对和权限校验保留。Main 十个相关文件 130 项通过。证据为 `reviewed-main-display-simplification-whole-r1.*`。
- TurnDuration 的首次 offscreen 读取等待原可见性信号。已开始的读取仍占原物理额度直到结束。浏览器覆盖首次可见、离开视口、实际刷新与取消。普通正文沿用原调度。C6 样本证实可见行等待读取，现有观测无法把每次等待归因于 TurnDuration。证据为 `reviewed-duration-first-visibility-whole-green-r1.*`。
- 已发出的受管纯过滤请求等待原物理结果，调用方取消后不发布结果。真实故障仍走原停止处理，普通工具取消契约保留。该批十文件 188 项通过，C8 九组万条历史均无观测到的 `MODS_POLICY_FAILURE` 停止。C7 失败样本中的停止次数只支持限定路径诊断。证据为 `reviewed-managed-policy-cancel-whole-r1.*`。

- NativeDestination 合并重复物理线程和同一逻辑会话的 JOIN，继续逐角色校验身份及两端引用；移除已由固定投影保护的旧别名检查。空 marker 候选完成原校验后直接返回。模型 SSE 流只累计新增文本的 UTF-8 字节，保留 64000B 上限、跨块代理对和终止顺序。相关六文件 205 项在 `phase2-provider-alias-focused-r1.log` 通过；这是限定回归，未单独量化各项的应用耗时收益。

共享对话的运行历史以 SDK checkpoint 与 writes 为准。AppDB 保留已提交的展示行和 Mods note 索引。没有被 SDK 引用的额外行不会自动进入恢复或 fork 的运行历史，也不会授予读取或确认权限。跨库 COMMIT 与 ACK 分别结算，恢复沿用原任务的重放规则。模型与工具的外部副作用仍可能再次执行，不能据此宣称跨库 exactly-once。

额外复核虚拟列表时，保留原滚动owner与测量API，删除了另造滚动校正系统的需要。新方案只对实际commit的保留(key,index)行，在原同一task中排一次microtask refresh并在rAF checkpoint前去重；不写scrollTop、不加重试。竖直margin条件另需一个同步viewport镜像，因原stream不是状态；这份标量有真实反例支持，不能为追求少变量改为读undefined。限定回归的自然single、受控latecheckpoint和自然aggregate均一次refresh/零观测blank，不外推无交集冷跳。

本轮没有为每个性能症状新增队列、持久状态表或通用恢复框架。真正不可合并的source/incarnation/physical-exit/COMMIT-ACK保护仍保留；具体最终状态见[检视台账](./mods-v2-remediation-review-ledger-2026-11-09.md)。

- prepared checkpoint、Host 快照和同摘要分支只移除同一同步阶段的重复校验。跨回调的复核、不同摘要的独立来源校验和事务前的最终校验均保留。无动作证据时省去未使用的快照根计算，有动作时仍在原位置解析并校验。相关定向运行分别通过 121 项 prepared 回归和 117 项 Host 回归。
- 原生配置读取和保存复用同一轮已完成的来源检查，最终来源和权限校验照旧。真实配置用例的完整检查分别由 16 次减至 13 次和由 40 次减至 29 次。该批 36 项定向回归通过，后续原 5 秒用例仍有超时。
- 目录分页按单条投影累计 UTF-8 JSON 字节，包含原包装和逗号。半页上限、总上限、游标与最终核对保持原语义。目录、边界及分支共 62 项断言通过，同次命令因一项 Vitest RPC 超时退出 1。现有样本不足以单独量化目录页面耗时收益。

证据为 `prepared-guard-dedup-r2-physical.*`、`host-unused-action-root-r2-focused.*`、`native-config-duplicate-checks-r2-focused.*` 和 `catalog-linear-and-stage-branch-focused-r1.*`。

- 冷的 UserMessage 和 AssistantMessage 已有物理读取请求获准取消时，直接在原发现和挂载边界结束剩余工作。继续使用原队列、预算、所有者与清理契约，旧协议、无请求 ID 和显式要求所有者的路径保留。未加入预取或静态证明特例，发布前后仍复核来源与权限。
- 实测 Main 采样中的热点包括挂载时的源存在性检查和绘制期间的新鲜注册表读取。相邻绘制校验仍有实际回调撤销反例，Windows 原生路径解析尚需实体路径、链接和 ASAR 的一致性验证，两项均未改。C9 的两次诊断记录了更多空窗，时长带有观测开销。

- 保留原检查点展示验证，只省去重复处理同一大段收据。Main 的第二次成员扫描曾提议建立局部 UUID 和原始序号索引。独立复核发现该阶段已执行来源回调，新增 Map、Set 等动态调用会扩大可被回调替换的校验面。最终撤回索引，只保留 Worker 指纹改动。
- Saver 的 flush/close 复用同一次已存在的关闭工作，未改存储格式或扩大读写权限。flush 已持有物理租约时先释放再等待同一次 close，避免相互等待。若 close 先开始，flush 直接等待其结果。原始 17 个 Saver 场景和七个真实崩溃窗口通过。
- Windows 离线探针在 Node 22 的 15 个对照中通过。四组每组 48 次调用，旧路径耗时 81.3–84.5 ms，原生候选 54.7–57.2 ms，配对节省约 0.56 ms/次。覆盖实体目录、路径别名、链接及形似 ASAR 的实体目录。真实 Electron 打包 ASAR、特殊文件系统和应用端收益仍待验证，当前产品继续使用原解析路径。
