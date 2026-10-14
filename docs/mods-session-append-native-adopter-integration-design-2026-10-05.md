# 原生记录接入已有显示记录：实际写入接线

日期：2026-10-05。此文是继续实现方案，基础测试通过不代表所有消息入口已接通。

## 解决的问题

桌面已经把用户输入或模型流式输出保存到显示记录里。Mods 接管这条消息时，应当在
原位置保存最终内容和完整原生记录，不能另建一条重复消息，也不能丢失原来的顺序、
工具身份、时间和用户输入来源。普通插件、普通会话仍使用已有写入方式。

## 原子写入和比较接口

1. `createFunctionConversationNativeProjectionAccess` 来自实际 producer 工厂，固定
   原数据库、会话身份、物理显示会话、run/producer、取消信号和真实 occurrence。
   receipt/claim 必须原私有 WeakMap 命中；同步 seal 与真实 flush 在首次等待前启动。
2. index 新增原事务内 native writer。参数只有原 private access/receipt、实际
   target/row、一次受保护的原 native projector 输出。不从 stamp 选择目标或权限。
   旧 hostFunctionRow 插入及普通 upsert 的授权和冲突行为保持原样。
3. Fresh 行先由 index 原 repair seam 在同一 Keeper 事务中修复/建立实际 bucket，
   从实际 next_ordinal 分配，并核至少 MAX(ordinal)+1。这一步是原事务的排序元数据
   修复；在第一条 raw 行 INSERT/UPDATE/fragment DELETE 前必须 prepare→claim。
   既有行不用新分配值；采用 captured 原 ordinal/provider/role/call/status/参数和时间。
4. prepare 严比所有原 23 列、完整 fragments/state、provider 占用及真实 alias handle。
   claim 先 latch 再 guard，任何失败不能领第二次 mutation。采用后仅更新已批准正文、
   reasoning、显示错误位、snapshot/authority/integrity 和 Keeper stamp；原工具参数、
   prompt origin、goal/window、时间、ordinal 原样。Full expected 由私有 prepare 返回。
5. raw INSERT/UPDATE、已核 fragments/state 清理和完整 projection receipt 在原 Keeper
   同一事务。既有行 bucket count/next ordinal 不改变；鲜行只按实际原 bucket增加一次。
   写后私有 assertPrepared 和原 raw/receipt 联验；无 Hook/model/tool 第二次执行。
6. TranscriptAccess 新第四参数仅 host 私有 native capture。write 缓存本次原 prepare
   的 expected/claim；verify 不重新格式化已采用的时间/来源，而核同一完整 expected。
   事务内使用 assertPrepared+原完整 receipt 检查，不释放 capture 占用，也不当 ACK。
   COMMIT 后才 access.verify，释放大 baseline/held；未知 COMMIT 仅同一 claim 只读核验。
   Store 仍负责实际提交和严格持久读回；postcommit 撤权拒 ACK，保已提交事实不重放。
7. index 的 alias driver 固定实际原 Map 对象、thread incarnation，以及相关 UUID 和
   provider 原 entry；输出私有 handle。比较实际 entries/对象身份，不能把公共数字
   revision/JSON clone 当证明。handle 无原 native occurrence 不产生准入。

## 生产清理接线

原 index.deleteThread 在原线程存在时，原事务首个删除前调用已双审 cleanup helper，
固定实际 DB、incarnation、原 metadata；family/raw full receipt/target journal 已预检。
真正 backend 的退休继续由原 IPC/workflow caller 完成。helper 不开 schema、不调用
Store.assertCurrent 作为删除后 guard、不追 source_json 删除独立 fork。线程不存在时
保留原普通删除行为，但若事务开始时出现新同ID线程则拒，避免误删 replacement。

原 Store.deleteThreadInTransaction 改为同一纯 helper；固定实际物理 thread identity，
不再按 threadId 扫除不同 incarnation 的 family。普通无 schema 删除不引入 Keeper。
alias Map 仅真实 COMMIT 后清理，失败回滚不能丢原 alias。

## 验证和下一步

新增实际 AppDB+Store 用例：既有 user 保来源/ordinal/时间；partial assistant 完整
fragments/state 收口；工具真实 call/status 与显示 is_error 分开；fresh 排序；任何
原列/alias/parts/lease/DB/ref 改变全事务零采用；未知 COMMIT 无第二写；事务内 verify
不释放256占用。实际 index 删除覆盖主、子、独立复制与同ID替换，并验证回滚。

本接线完成后继续实际 input/response/tool/notice/attachment/compaction producer门。
这些入口必须用原调用的 run、模型结果或工具返回值，不能事后遍历 role 冒充原入口。
完整内容保护必须 typed capture→first protect 在 Retainer/codec 前；原生门还要真实
renderer late echo seal 和 loaded-only Hook dispatch。仍需独立方案及实际 Electron验证。
