# 原生输入的首次写入意图与展示 disposition

日期：2026-10-05。状态：Root、Latest、Official 已给正式设计 PASS；基础模块与独立测试
正在收口，尚未完成同事务写口和显示消费接线，未声称产品验收。
已有 Human baseline、真实输入保护与 saved ACK/drain handoff 合同保持。这里不生成 ACK、
新 authority、Goal 或消息权限，也不以空正文、公开 metadata、isMeta 判定隐藏。

## 原真实入口与意图

Root 原 `persistVisibleUserTranscriptMessage` 的可选 onWrite 返回实际原
`ThreadMessageWrite` 地址与 `persisted|blank|plumbing`。persisted 只在原 upsert 成功且
changed>0 后通知；blank/plumbing 是原明确跳过 UI 的分支。插件/composer 也在各自原
真实写口通知。本 run 局部最后值传给实际 NativeInput 工厂，不增加 renderer API。

NativeInputCapture 增加：

```ts
readonly transcript?: {
  readonly write: ThreadMessageWrite
  readonly disposition: "persisted" | "blank" | "plumbing"
}

// read/bind actual opaque NativeInput receipt only
readonly transcript?: FunctionNativeInputTranscriptIntent

readInputTranscriptIntent(token: FunctionNativeInputTranscriptIntent): Readonly<{
  uuid: string
  threadId: string
  physicalRunId: string
  disposition: "persisted" | "blank" | "plumbing"
  intentDigest: string
  write: ThreadMessageWrite // independent descriptor-safe copied data, never the original address
  assertCurrent(): void // original actual source, write data and physical identity
}>
```

intent 由实际 capture 内的私有 WeakMap mint；clone/等值 JSON/公开 UUID 不得 read。
首源 callback 前安装 once/latch。exact original write 的 user role/ID 必须与实际 Human
相同；thread/run/DB/inc/lease/directory 与原 source 固定。原 Date 用 exact Date prototype
及 captured Date.prototype.getTime 获取毫秒，不执行 toJSON/getter；每次 read 完整复核
原 write descriptors/所有使用字段/日期值，原 source callbacks 前后均核。禁 forged
function_row/invalid、公开 prompt_origin、未知写参数、caller ordinal 和 delta modes。
fixed original content/Goal/window/priority/source modes/times 经过原真实 formatter 一次。

persisted 通知的原语义意味着实际 baseline 在 capture 时存在。须捕获并核原 23 列/
完整 fragments/state/actual alias，不把后来消失的 persisted 行当 fresh。真正没有 UI 行
只由 blank/plumbing 私有 disposition 证明；无 transcript 时既有 baseline 原路径继续，
缺 baseline 仍 WRITE_INTENT_REQUIRED。未来其他 fresh visible 入口须单独真实 before-write
协议，不把当前 after-success 通知改称它。插件 prompt_origin 仅采用原 private writer
选项/actual baseline；write.prompt_origin 与 origin 名称均不能补造缺失 provenance。

这个原 baseline 是 capture 阶段的真实资格与 before-adoption 固定数据，不要求合法
COMMIT 后 raw 行永远等于未采用旧列。NativeProjection 在原 seal/flush 与实际 prepare
阶段将自己的 baseline 与此固定事实核对；采用后的读取改核原 prepared claim/真实
canonical receipt/新 23 seal/ledger。source intent 自身继续核原 write 数据与独立物理源，
不在 read 时根据当前 UI重新认定 disposition，也不因本次真实改body/stamp而撤掉输入。

## 完整保护与 no-bubble 投影

blank/plumbing 仍完成 first protect、实际公开 append（若可用）、final protect、完整
canonical native payload、原同次 graph submit 与 CP membership。不能跳 Hook 或把
未保护 raw 输入送模型。Human presentation 由 actual intent/source/result proof 固定
此 disposition，保护成功后 no-bubble 只影响 UI 投影，不改变原完整 native/HTTP 正文。

原 Keeper same AppDB txn 分配实际 ordinal 后，fresh no-bubble 使用原 exact write 的
formatter来源列，保原 flags/Goal/window/times；content_json 固定为 JSON 空 string、
recovery_integrity=0，function_row_json 为真正 canonical stamp，fragments/state=0。
所有 23 列仍由原 projection receipt 完整认证。空 content 不是隐藏权限，消费者只能
根据下面实际持久回执隐藏。ToolReturn Human 共用纯 formatter，但不借 prompt intent/
Goal；它需要独立 actual tool source/ledger 合同，不自动进入本案。

## canonical commit anchor 与独立持久 ledger

为避免“删除 ledger 后假装 legacy visible”，无需修改 thread_messages 23 列：实际
NativeInput adopter 的 canonical orderAnchor 增加固定 data-only 字段：

```ts
presentation: { version: 1, disposition: "persisted" | "blank" | "plumbing", intentDigest }
```

只有原 actual presentation/intent token 可给真实 adopter 此数据。公开 marker 本身
不授显示/存储权。canonical row 的原完整 row digest 已覆盖 orderAnchor，再由原持久
projection receipt 绑定，使新 marker 无法降为 legacy 而通过原 receipt 全链。

新增 `function_conversation_presentation_dispositions`，exact primary key 为
(thread_id, incarnation, uuid)。全部 NOT NULL scalar：target_json、canonical_receipt_id、
canonical_row_digest、native_payload_digest、projection_digest、anchor_digest、intent_digest、
disposition、version。incarnation 与现 projection receipt 同固定 token/legacy编码；
target_json 与原 8 字段完整 ref 同编码。由原 writer 全列验证/记录 projection receipt
后、同 Keeper txn 记录，existing 不覆盖；真实 readback 全字段一致才完成保存验证。
写事务内验证不释放实际 held/baseline，原 COMMIT 后正式 verify/真 drain 门保持。
unknown COMMIT 只复核原 claim+canonical+23 receipt+ledger，不重发写口。

新 data-only API（不生成 authority、不调用 source/proof callbacks）：

```ts
readFunctionConversationPresentationDisposition(
  db: NativeSqliteAdapter,
  actualSelection: FunctionConversationProjectionSelection,
  actualColumns: FunctionConversationProjectionColumns
): Readonly<{ kind: "visible" | "blank" | "plumbing"; fingerprint: string }>
```

必须先在 caller 的真实 scope/txn 中完成 actual canonical row/native payload/full stamp/
23 sealed receipt 校验。reader 再精确原 PK 核 ledger/anchor/ref/all digests，不接 public
stamp 选择 target。无 marker 且无 ledger 的真正旧 canonical 行=visible；有 marker 缺
ledger=MIGRATION_REQUIRED；ledger 有而 marker 无、字段不匹配=CONFLICT。表不存在但
marker 存在同样拒，不能读时建 schema。空正文/Goal文本/公开 flags 不影响分类。

## 真实消费者与生命周期

- Main CP/helper/hydration 显式 A/B read scope：每次 fresh 23 seal 与 ledger A，最后原
  source/proof callbacks 后 fresh 23 seal 与 ledger B，比较全部固定 scalar；B 后只有
  pure 决定是否输出，不能再 callback 后返回旧 disposition。
- Worker 在原 actual appDB readonly txn 内验证完整 CP membership/native array digest/
  rawIndex/23 seal，并同 txn 读 ledger。no-bubble 仅省略 bounded display DTO，不改完整
  native/CP/member/rawIndex，不能把完整 CP搬 Main。
- Root InputRetention readSaved 也纳入实际 ledger，saved handoff 新 candidate 独立
  registration/read 不复用旧 presentation callback；原 true ACK/drain/policy门不变。
- raw canonical fork 验原 ledger与receipt 后，只映射新实际 target/thread/inc，目标
  canonical row/projection receipt/ledger 同 txn 新建；不复制源 ACK 作目标 proof。
- thread/family cleanup 精确原 inc 删除相应 ledger，ABA 替代 raw/UI/ledger 保留。

## 分工与门禁

本 agent 拥有新 intent/ledger helper与 tests、NativeInput/presentation/Human projection
窄分支；Root owns IPC callback、retention/adopter/index真实事务接点；Latest Store 轻
schema/cleanup/fork 接缝先协调；Official owns Main/Worker/display消费者。任何旧源改动
先明确区域并避免并行写。现大型 Human 默认5门先独立保持，不能以 schema 改动隐藏慢。

真实测试需 exact original callback、AppDB/lease/Manager/protector/Keeper/Store：persisted
完整来源保持；blank/plumbing canonical/HTTP完整而真实 display 0气泡；clone/缺 ledger/
坏 anchor/日期 getter/源重入/changed raw/ABA 拒；同 txn rollback 0ledger/0row；unknown
COMMIT 一写；fork目标新ledger与source pending保留；legacy无 marker visible 不变。
