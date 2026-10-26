---
name: autobiz-native-prd
description: 消费固定需求并编制带来源与实现范围的PRD
---

读取 `NORMALIZED_REQUIREMENTS.json`，逐条保留全部 requirements 原文，在 PRD 写明
`来源：NORMALIZED_REQUIREMENTS.json`。需求不是事实证据；需要用户裁定的内容先提问，
取得结论后写回，不能仅删除 `【待确认】` 标记。

输出 `PRD.bundle.json`，结构为 `{feature, stage:"prd", files:{相对文件名:UTF8文本}}`。
files 必须包含 `PRD.md`、`IMPLEMENTATION_SCOPE.json`、`UI_CONTEXT.json`。
PRD 使用正式标题“外部资料与实现约束”和“当前实现范围”；没有外部资料时来源段写“无”。
有外部资料时使用稳定 SRC-NNN 表格（ID、类型、名称、地址/路径、约束范围、状态），
同时提供 `source-context.json` 与可分发的 `sources/SRC-NNN/文件名` 快照，保留来源可读性和时效。

IMPLEMENTATION_SCOPE 包含 featureId、implementationScope（full_stack/backend_only/frontend_only）
和真实来源 source。UI_CONTEXT 遵守原 version:1 契约：featureId、uiRequired、decisionStatus、
pages、interactions、visualSources、capabilities；无 UI 需 notApplicableReason，不能假定后端范围。
此阶段先形成确认的UI范围，规格阶段补齐REQ/SCN引用后锁定。

bundle 是 Host 实际验收的产物；不要另写独立散文件并让 bundle 引用未固定的内容。
公开检查器只读取已固定产物，Host 根据其回执决定推进。

## 精确文件契约与来源分支

以下 JSON 是**结构示例，不是当前任务的业务结论**。`example-feature`、示例名称、说明和路径必须根据实际输入替换；不能复制示例内容冒充用户确认、读过资料或存在快照。所有内层 JSON 都先序列化成 UTF-8 文本，再作为 `files` 对应键的字符串值，不能把对象直接嵌入 files。所有 feature/featureId 与 NORMALIZED_REQUIREMENTS.json.feature 完全相同。

IMPLEMENTATION_SCOPE.json 只有三个必需业务字段：`featureId` 非空字符串、`implementationScope` 为 `full_stack/backend_only/frontend_only` 之一、`source` 为真实范围决策来源的非空字符串。不存在 `scope`、`mode` 等替代字段。当前 Code 执行器只支持 backend_only；用户需要其他范围时保留真实要求并说明能力阻断，不能为了推进擅自改为后端。

<!-- autobiz-prd-scope:start -->
```json
{"featureId":"example-feature","implementationScope":"backend_only","source":"结构示例：实际填写用户明确范围决策的来源"}
```
<!-- autobiz-prd-scope:end -->

**确实没有外部资料：**在 PRD 中使用独立标题 `## 外部资料与实现约束`，该节正文只写 `无`，下一节另起同级标题。不创建 source-context.json，不填空 sources 数组，不登记虚构 SRC。原始需求文本不是外部资料快照。已登记或实际依赖的资料缺失不属于“无资料”，不能删来源来通过。

**已提供资料：**来源节使用完整表头 `| ID | 类型 | 名称 | 地址/路径 | 约束范围 | 状态 |` 和 Markdown 分隔行；每条 SRC-NNN 唯一。外部接口/第三方接口的六列必须有真实非空值。表格的地址/路径描述原始位置，下面 JSON 的 `path` 则必须指向 bundle 内快照，两者用途不同。只保存实际获准可分发的正文，不保存凭据。

source-context.json 顶层是 `{version:1,sources:[...]}`，整数 version 不能省略、不能写字符串或其他版本；有来源时 sources 非空，其 ID 集合必须与 PRD 来源表完全一致。每项使用以下字段，不能用 status/location/snapshotPath 替代：
- `id`：`SRC-001` 形式；`name`：资料真实名称。
- `availability`：只允许 `live`（原资料可访问）、`snapshot_only`（只能使用已保留快照）、`never_provided`（从未提供）。这不是是否已读的状态。
- `readStatus`：只允许 `complete/partial/unreadable`，按实际读取程度填写。
- `freshness`：只允许 `current/stale/unknown`；无时效证据用 unknown，不推定 current。
- `path`：除 never_provided 外，填写实际非空快照相对路径 `sources/<同一SRC-NNN>/<ASCII文件名>`，并在本 bundle.files 中用完全相同的键保存快照文本。例如 sources/SRC-001/reference.txt。不能写本机绝对路径、URL或仅目录名；文件名只用英文字母、数字、下划线、点、短横线，不嵌套目录。

<!-- autobiz-prd-source-context:start -->
```json
{"version":1,"sources":[{"id":"SRC-001","name":"结构示例：已读取资料的实际名称","availability":"snapshot_only","readStatus":"complete","freshness":"unknown","path":"sources/SRC-001/reference.txt"}]}
```
<!-- autobiz-prd-source-context:end -->

**确实从未提供的依赖资料：**仍登记真实的 SRC，availability=never_provided、readStatus=unreadable、freshness=unknown；不编造 path/快照。向用户明确请求提供、明确解除该依赖或暂停等待。原规则对这些字段/缺快照可能仅给 warnings；warnings 不是“资料已读”，更不授权擅自解除依赖。检查消息中旧 `source_context.py sync` 是历史指引，本包不调用旧 writer；按以上契约修本阶段 bundle。

## UI_CONTEXT.json 的完整字段

顶层必需：`version:1`、`featureId`、布尔 `uiRequired`、`decisionStatus`、四个对象数组 `pages/interactions/visualSources/capabilities`。decisionStatus 仅允许 `defaulted/confirmed/locked`；PRD 在实际确认范围后用 confirmed，Specs 才在有真实规格引用后 locked。可选 decisionSource 仅允许 `user_confirmed/prd_inferred/default_false/legacy_import`，按事实选；可选 confirmedAtCheckpoint/lockedAtCheckpoint 是非空字符串，但它们不是 Host 审批凭据，不得伪造批准。

无 UI 必须提供非空 notApplicableReason；不能因没有前端实现就猜 uiRequired=false。确已确认无 UI 时，四个数组可为空，不必编造 PAGE/VIS/REQ。结构如下：

<!-- autobiz-prd-ui-none:start -->
```json
{"version":1,"featureId":"example-feature","uiRequired":false,"decisionStatus":"confirmed","decisionSource":"user_confirmed","notApplicableReason":"结构示例：实际填写已确认的不适用理由","pages":[],"interactions":[],"visualSources":[],"capabilities":[]}
```
<!-- autobiz-prd-ui-none:end -->

有 UI 时，按以下准确字段表达，不能把数组换成字符串列表或按 ID 建对象映射：
- pages 项：`pageId` 为 PAGE-NNN；`name/goal` 非空；可选非空 routeHint、字符串数组 states。
- interactions 项：`interactionId` 为 UIX-NNN；`pageId` 引用已声明页面；`summary` 非空；可选 stateRefs 字符串数组、specRefs 字符串数组。
- visualSources 项：`sourceId` 为 VIS-NNN；`type` 为 high_fidelity_html/standard_html/design_link/prototype_link/image/other；`path` 非空真实位置；可选 route 为 spec-driven-ui/absolute-html/standard-html/missing-html（这里不能为 none）、布尔 required、小写64位十六进制 contentSha256/bundleSha256。摘要必须真实计算，不能生成占位哈希。
- capabilities 项：`capabilityId` 为 kebab-case；可选布尔 uiRequired；**pageRefs 和 interactionRefs 都必须是字符串数组，即使为空**；可选 visualSourceRefs 字符串数组。所有引用必须存在。specRefs 在 PRD 可省略，Specs locked 时每个 capability 都必须有非空 specRefs，合起来含已定义的 REQ-NNN 和 SCN-NNN；使用完整 `specs/<能力>/spec.md#REQ-NNN` / `#SCN-NNN`。

uiRequired=true 时 pages/interactions/capabilities 至少一项非空；locked 时至少一个 capability 的 uiRequired 不为 false。uiRequired=false 时不能有 uiRequired=true 的 capability。各类 ID 分别唯一。required=true 且声明 contentSha256 的视觉来源在 locked 后必须被某个 capability.visualSourceRefs 引用。尚未写规格的 PRD 不得填不存在的 REQ/SCN。

当前 bundle 限制也要遵守：每个内层文本非空且不超过20000 UTF-8字节；PRD.bundle.json 本身不超过28000字节；此阶段 files 除上述四种文档外，只允许 `sources/SRC-NNN/文件名`。资料过大、不可分发或不可读时如实报告，并请用户决定合规的来源交付方式，不静默截断后声称完整读取。
