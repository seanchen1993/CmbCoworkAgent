# F03 · v1 契约设计决定

2026-10-01 · 版本 1 · 主代理设计；不是已部署服务。

## 1. 交付边界与唯一来源

本轮冻结 Bot/Group、工作模式交接与 Runtime 的最小协作契约及可执行一致性样例；不建设服务端、数据库、调度器或云节点。需求/原型/项目现有代码保持原有入口。群接入、Routine、自动记忆、ES 和真实发布适配不进入 v1 实现表面。

- `contracts/bot/v1/schemas.json`：JSON Schema 2020-12，所有实体、请求、响应、Runtime 消息的唯一字段定义（`$defs`）。
- `openapi.json`：OpenAPI 3.1.0，路径、鉴权、状态码、关联说明；业务 DTO 全部引用上面的 `$defs`，不重复手写另一份 schema。
- `runtime.schema.json`：仅引用主 schema 的 RuntimeEnvelope；`state-transitions.json` 为状态转换的唯一枚举表。
- `src/shared/bot/contracts.generated.ts`：从 schemas 的受支持子集确定性生成。禁止手写镜像 DTO。生成器遇到不支持的关键字必须报错，不能静默输出 any。
- 契约测试校验所有 `$ref` 可解析、OpenAPI operationId 唯一、每条 operation 的请求/响应与 fixtures、运行时消息变体、生成文件漂移。JSON Schema 与状态模型测试不等于生产权限或分布式一致性已实现。
- 使用仓库已解析的 Ajv 8.18.0 与 ajv-formats 3.0.1 做 schema 校验；声明为直接 devDependency，版本不升级。允许离线更新 lock 根依赖元数据，不联网安装依赖。

## 2. 全局约定

- 所有业务 API 前缀 `/api/bot/v1`，HTTPS。认证为 bearer 身份；`X-DevClaw-Space` 只是空间选择器，服务端验证主体成员资格，不信任 header 自带权限。
- 请求体禁止 `actorId`、`principalId`、`spaceId`、授权断言、原文 Token、任意 endpoint、执行机器绝对路径。Group 成员配置里的 `principalId` 是待授权成员目标，不是当前操作者身份，必须单独鉴权。
- 写命令含 `commandId`；改变已有对象或往对象追加内容，含该对象 `expectedVersion`。创建全新 Bot/Group/Task/Upload 不要伪造 version=0。POST /runs 的 expectedVersion 指 Task，不是尚未创建的 Run。
- `commandId` 在 `(spaceId, authenticatedPrincipalId)` 范围去重；指纹包含 method、规范路径与规范 JSON body（不含 commandId），拒绝同 ID 不同操作/对象/载荷。服务端只在同一事务持久命令回执、变更与 Outbox 后返回成功。
- 对相同命令返回原结果前仍重新鉴权，撤权不得通过重放取得历史内容；幂等查询必须先于 expectedVersion 的当前值比较，否则成功后的正常重试会误报版本冲突。保留期由服务端公布，过期命令不无条件当全新写入重放。
- 二进制 PUT 的 If-Match 使用严格强 ETag：双引号包裹无前导零的正十进制版本（如 `"1"`），解析后还须在安全整数范围内；不接受弱 ETag、星号或列表。指纹包含 method、规范路径、实际收到字节的 sha256、规范 mediaType 与 If-Match，不含 X-Command-Id；不能信任客户端自报摘要。v1 mediaType 取请求实际 Content-Type，为 schema 接受的无参数小写 type/subtype，且须与 UploadSession.mediaType 一致；不是另加的 JSON 字段，OpenAPI 与 fixture 必须表达同一传输约定，不能只声明 octet-stream 却在接收模型要求 text/plain。读取与哈希仍受上传大小上限约束，重复请求也不能绕过；当前鉴权之后查同命令回执，再对新写执行 CAS。同 ID 改变字节、mediaType 或 If-Match 必须冲突。
- ID 为非空、最长 128 的不透明字符串，pattern `^[A-Za-z0-9][A-Za-z0-9._:-]*$`；版本、fence 和 eventSeq 为 1..9007199254740991 的整数。所有日期为 UTC `Z` 后缀 RFC3339，字节摘要使用 `sha256:` 加 64 位小写十六进制。
- 对象一律封闭未知字段（additionalProperties:false；组合时正确使用 unevaluatedProperties）。不使用任意 `metadata`/`payload` map 隐藏未定义接口；可选字段省略，不在未说明时混用 null。
- 字符串/数组有显式合理上限；文本内容不授予权限。Schema 的结构校验不保证自然语言没有秘密，Runtime/网关仍需独立脱敏和数据权限控制。
- 错误响应：`{requestId,error:{code,message,retryable,currentVersion?,retryAfterSeconds?}}`。固定安全说明，不带异常栈、凭据或上游响应。未知副作用不标记 retryable=true。
- 基础错误码：INVALID_PAYLOAD(400)、SCHEMA_VERSION_UNSUPPORTED(400)、UNAUTHENTICATED(401)、FORBIDDEN(403)、NOT_FOUND(404)、VERSION_CONFLICT(409)、COMMAND_CONFLICT(409)、COMMAND_EXPIRED(409)、INPUT_CHANGED(409)、APPROVAL_REQUIRED(409)、APPROVAL_EXPIRED(409)、NODE_OFFLINE(409)、CAPABILITY_UNAVAILABLE(409)、OUTCOME_UNKNOWN(409)、CURSOR_EXPIRED(410)、PAYLOAD_TOO_LARGE(413)、RATE_LIMITED(429)、DEPENDENCY_UNAVAILABLE(503)。

## 3. 核心对象（字段命名冻结）

`EntityMeta = id, spaceId, version, createdAt, updatedAt`；只存在响应/权威记录。配置/成果内容版本不等于实体 CAS version。下表 `?` 表示可选，具体 required 集合必须清楚体现于 schema。

| 定义 | 核心字段及语义 |
| --- | --- |
| ArtifactVersionRef | artifactId, versionId, digest；必须三者匹配，不能只用 latest |
| GrantRef | grantId, version；服务端派发前与恢复时重新校验 |
| CredentialBinding | credentialRef, purpose；purpose 为 requirement_read / requirement_publish / repository_read / repository_write；没有 secret 或 token 字段 |
| ModeRef | id=requirement / assessment / prototype / project，version=1；assessment 是只读技术评估，不放宽 requirement 禁止编码的限制 |
| Budget | maxTokens, maxDurationSeconds, maxToolCalls，均为正整数；Group 另有 maxHandoffs 和 maxRuns |
| BotConfig | description, instructions, knowledgeRefs[], repositoryRefs[], skillAllowlist[], capabilityCeiling[], memoryPolicy=disabled / explicit_only, persona?；引用不复制资源权限 |
| Bot | EntityMeta + name, status=active / disabled, currentBotVersionId, maintainerIds[]；BotVersion 由服务端创建 |
| BotVersion | id, botId, spaceId, number, config:BotConfig, createdAt；不可变 |
| Group | EntityMeta + name, bots[{botId,botVersionId,role}], members[{principalId,role}], limits；bot role=coordinator / specialist；human role=admin / participant / business_owner / technical_owner |
| Task | EntityMeta + groupId, taskNumber, title, goal, status, currentStageId, stages[], inputArtifactVersions[]；Stage={id,kind,status,inputArtifactVersions[],outputArtifactVersions[]}，kind=requirement / assessment / prototype / scope_confirmation / development |
| TaskMessage | id, spaceId, taskId, authorPrincipalId, text, artifactVersions[], createdAt；新增消息不自动授权 Run |
| ThreadBinding | spaceId, taskId, stageId, runtimeNodeId, provider, localThreadId；不是 Group 永久绑定一条 Thread |
| Artifact | EntityMeta + taskId, kind=source / prd / assessment / prototype / development_handoff / verification, currentVersionId |
| ArtifactVersion | id, artifactId, spaceId, taskId, number, digest, mediaType, sizeBytes, blobRef, createdAt, createdBy；Blob 引用由服务端生成，已提交内容不可变 |
| UploadSession | id, spaceId, taskId, version, purpose, fileName, mediaType, sizeBytes, digest, status, expiresAt；status=created / uploading / verifying / committed / rejected / expired；文件名不是路径 |
| Approval | EntityMeta + taskId, kind=business_scope / technical_handoff / tool_action, inputArtifactVersions[], requestedAction?, approverIds[], status=pending / approved / rejected / expired / invalidated, expiresAt；tool_action 必须有 requestedAction，其他种类不得假装工具授权 |
| ApprovalDecision | id, approvalId, spaceId, principalId, decision=approve / reject, comment?, inputArtifactVersions[], createdAt；principalId 由服务端填充 |
| Handoff | EntityMeta + taskId, fromBotId, toBotId, inputArtifactVersions[], expectedOutput, status=pending / accepted / running / completed / rejected / cancelled / outcome_unknown, budget, deadline；接受不代表工作完成 |
| DevelopmentHandoff | id, spaceId, taskId, commandId, prd:ArtifactVersionRef, assessment:ArtifactVersionRef, prototype?:ArtifactVersionRef, repositoryRef, repositoryRevision, acceptanceCriteria[], exclusions[], openQuestions[], businessApprovalId, technicalApprovalId, createdAt；正式版本不可替换 |
| ProjectBinding | handoffId, provider, projectId, featureRef?, localThreadId?, createdAt；Feature 仅为现有项目适配内部引用 |
| RuntimeNode | EntityMeta + provider=desktop / hosted, status=online / offline / draining / disabled, capabilities, lastSeenAt；不含本地绝对路径 |
| WorkspaceSpec | workspaceRef, isolation=task, access=read / write, repositoryRef?, repositoryRevision?, inputArtifactVersions[]；repositoryRef 与 revision 同时存在或同时省略 |
| Run | EntityMeta + taskId, stageId, botVersionId, mode, inputArtifactVersions[], status, activeAttemptId?, requesterPrincipalId, budget, deadline；最后一个 token 不是成功证明 |
| RunAttempt | id, spaceId, runId, number, runtimeNodeId, status, lease:Lease, startedAt?, finishedAt?, checkpointRef?；attempt 是实际派发，不是通知重发 |
| Lease | leaseId, fence, expiresAt, authorizationVersion；fence 在同一 Run 的后续 attempt 单调递增 |
| RunSpec | schemaVersion=1, runId, attemptId, taskId, stageId, botVersionId, mode, contextManifestRef, inputArtifactVersions[], workspace:WorkspaceSpec, grant:GrantRef, credentialBindings[], approvalIds[], budget, deadline；由服务端解析并冻结，不接受客户端原样上报作为授权 |
| Delivery | id, spaceId, runId, attemptId?, eventId, destinationRef, status, attempts；只表示消息交付 |

capability 使用封闭枚举：requirements.analyze、repository.read、prototype.generate、workspace.write、command.execute、requirements.publish。请求能力与主体授权、Bot ceiling、Group/Task 资源授权、模式、节点、当前审批取交集。不得把交集外的请求能力静默降级后宣称原请求执行成功：应拒绝并说明缺少能力。

模式能力上限：requirement 只支持 requirements.analyze 与有独立工具批准的 requirements.publish；assessment 只支持 repository.read；prototype 支持 prototype.generate 与限于原型工作区的 workspace.write；project 支持 repository.read、workspace.write、command.execute。需求成果写入属于受控模式产物 API，不意味着获得任意写应用代码能力。

Group limits={maxHandoffs,maxRuns,maxTokens}。knowledgeRefs/repositoryRefs/blobRef/contextManifestRef/checkpointRef 均为不透明 ID，不是可任意 fetch 的 URL。requestedAction={capability,resourceRefs[],inputDigest}；entityRef={kind,id,version}，kind 为 bot/group/task/artifact/approval/run/delivery。provider/localThreadId 组合映射仅由有权适配器写入。

实施前枚举澄清：UploadSession 和 CreateUpload 的 purpose 使用同一 ArtifactKind 定义（source/prd/assessment/prototype/development_handoff/verification），不复制第二份枚举。用途声明不授予成果权限；创建 Artifact 时必须核对 Upload 属于同一 Task、已 committed，且 Artifact.kind 与 purpose 一致。ThreadBinding/ProjectBinding.provider 为已注册会话/项目适配器的 ProviderId，复用 ID 的长度与字符限制；由有权服务端适配器写入，不是任意 URL，也不表示客户端可注册 provider。RuntimeNode/register.provider 则是 desktop/hosted 部署类型枚举。结构合法的 ProviderId 仍必须通过服务端注册与授权检查。

## 4. API 表面

所有列表/数组有上限；读取接口响应仍鉴权。创建结果包含实体及版本；异步 Run、handoff、upload complete 返回 202 时明确只是 accepted/verifying。下面的 `input` 仅为表述简写：命令字段扁平化，包含 commandId / 需要时的 expectedVersion，不生成不透明 payload。

| method/path | 输入要点 | 输出 |
| --- | --- | --- |
| POST /bots | name, config, maintainerIds | Bot + BotVersion（201） |
| GET /bots/{botId} | 路径 ID | Bot + current BotVersion |
| POST /bots/{botId}/versions | expectedVersion, config | Bot + 新 BotVersion（201） |
| POST /groups | name, bots, members, limits | Group（201） |
| GET /groups/{groupId} | 路径 ID | Group |
| PUT /groups/{groupId}/members | expectedVersion, bots, members | Group |
| POST /tasks | groupId, title, goal, inputArtifactVersions | Task（201） |
| GET /tasks/{taskId} | 路径 ID | task:Task + snapshotCursor（同一一致性快照的增量起点） |
| POST /tasks/{taskId}/messages | expectedVersion, text, artifactVersions, targetBotId? | TaskMessage + taskVersion（201） |
| POST /tasks/{taskId}/stage-transitions | expectedVersion, toStage, inputArtifactVersions, approvalIds | Task |
| POST /uploads | taskId, purpose, fileName, mediaType, sizeBytes, digest | UploadSession（201） |
| PUT /uploads/{uploadId}/content | 二进制；header X-Command-Id 与 If-Match 指 upload version | UploadSession；首版是受鉴权代理上传，不向模型发预签名 URL |
| POST /uploads/{uploadId}/complete | expectedVersion, digest, sizeBytes | UploadSession（202 verifying，200 committed）；校验成功后方可引用 |
| POST /tasks/{taskId}/artifacts | expectedVersion, uploadId, kind | Artifact + 首个 ArtifactVersion（201）；upload 必须已 committed 且属于 Task |
| POST /artifacts/{artifactId}/versions | expectedVersion, baseVersionId, uploadId, changeDescription | Artifact + 新 ArtifactVersion（201） |
| GET /artifacts/{artifactId}/versions/{versionId} | 路径 ID | ArtifactVersion |
| GET /artifacts/{artifactId}/versions/{versionId}/content | 路径 ID | 经当前鉴权的二进制内容，不返回长期 S3 密钥或内部 bucket/key |
| POST /tasks/{taskId}/approvals | expectedVersion, kind, inputArtifactVersions, requestedAction?, approverIds, expiresAt | Approval（201） |
| POST /approvals/{approvalId}/decisions | expectedVersion, decision, comment?, inputArtifactVersions | Approval + ApprovalDecision |
| POST /tasks/{taskId}/handoffs | expectedVersion, fromBotId, toBotId, inputArtifactVersions, expectedOutput, budget, deadline | Handoff（202） |
| POST /tasks/{taskId}/development-handoffs | expectedVersion, prd, assessment, prototype?, repositoryRef, repositoryRevision, acceptanceCriteria, exclusions, openQuestions, businessApprovalId, technicalApprovalId | DevelopmentHandoff（201）；不自动创建项目或执行代码 |
| POST /runs | expectedVersion（Task）, taskId, stageId, botId, mode, inputArtifactVersions, workspaceRef, requestedCapabilities, approvalIds, budget, deadline | Run（202），不是客户端提交完整 RunSpec |
| GET /runs/{runId} | 路径 ID | Run + attempts[] |
| POST /runs/{runId}/cancel | expectedVersion, reason | Run（202 cancel_requested，不返回虚假已停止） |
| GET /events | after? opaque cursor, limit<=200 | events[] + nextCursor + hasMore；过期 410，不静默从最新开始漏事件 |

这里不提供有副作用的任意 tools API，也不在 F03 增加 IM binding 真接口。组建 Group 的权限不等于群管理员权限；后续群协议单独版本化，保持现有 IM V1 完全兼容。

创建 Task 初始为 active，首个 requirement Stage 为 active，其余 stage 为 pending。事件首次读取未提供 after 时只取得当前 head cursor（events=[]），客户端从 Task 快照的 snapshotCursor 开始增量，不能拿“较晚查询的当前 cursor”覆盖旧快照起点而漏事件。每次读增量仍按当前权限过滤；cursor 不是权限凭证。

## 5. 状态和审批

- Task：draft → active；active ↔ awaiting_business / awaiting_technical；active 或等待确认态可进入 handed_off（双确认），handed_off → completed；非终态可 cancelled。completed/cancelled 终态。阶段变更与 Task 状态分开，不允许模型自行确认。
- Stage：pending → active → waiting_confirmation 或 completed；waiting_confirmation → active 或 completed；非终态可 cancelled。范围确认进入 completed 需要业务与技术两类准确版本批准；开发阶段开始还须工具授权。
- Run：queued → waiting_node / starting / cancel_requested；waiting_node → starting / cancel_requested；starting → running / failed / outcome_unknown / cancel_requested；running → waiting_approval / succeeded / failed / outcome_unknown / cancel_requested；waiting_approval → running / failed / cancel_requested / outcome_unknown；cancel_requested → cancelled / succeeded / failed / outcome_unknown（完成与取消竞态不伪造取消）；终态 succeeded/failed/cancelled 不回退。
- outcome_unknown 只能经 inspect/外部回执对账解析为运行中或准确终态，不能仅凭超时开始新 attempt；是否允许重新执行另需人工决定，不自动把它转换为 queued。
- Attempt：dispatched → accepted → running；accepted/running 可 waiting_approval、cancel_requested、failed、outcome_unknown；dispatched 也可 cancel_requested/outcome_unknown；waiting_approval → running/cancel_requested/failed/outcome_unknown；running → succeeded；cancel_requested → cancelled/succeeded/failed/outcome_unknown；相同终态幂等，不能覆盖不同终态。
- Delivery：pending → accepted / failed / outcome_unknown；accepted → delivered / failed / outcome_unknown；failed 可 pending（仅重发消息）；outcome_unknown 先对账。消息投递变化不得创建 Run/Attempt。
- Approval：pending → approved/rejected/expired/invalidated；已批准输入或授权变化后 → invalidated。同一输入版本重复决定可返回原回执；相反决定、过期、撤权、不符版本拒绝。业务确认、技术确认和工具授权不可互相替代。
- UploadSession：created → uploading/rejected/expired；uploading → verifying/rejected/expired；verifying → committed/rejected/expired。committed/rejected/expired 为终态，complete 的相同命令重试返回原回执，不重新开放内容覆盖。
- Handoff：pending → accepted/rejected/cancelled；accepted → running/cancelled/outcome_unknown；running → completed/cancelled/outcome_unknown。outcome_unknown 仅通过对账进入 running/completed/rejected/cancelled，不重新创建交接或 Run；其他终态无普通后继。
- PRD 更新后，不修改旧成果/旧交接；尚未发起的阶段要求重新确认，在途开发不偷偷换输入，产生新的变更请求。不得依靠清空 approvalIds 隐式绕过门禁。

2026-10-02 重放边界澄清：已经成功的 DevelopmentHandoff，其原 commandId 与原载荷重试，在当前仍有权读取该任务和交接回执时返回原不可变回执；之后 PRD 更新、旧批准失效或当前 CAS 变化不重做已完成交接，也不把历史成功改判成 INPUT_CHANGED。新的 commandId 必须重新核对最新输入与双确认，不能使用旧批准创建新交接。参考模型须区分当前身份/资源可见性检查与“新写入”的输入/批准门禁，后者不能放在通用的回执查询前；撤权后历史回执仍不可读取。ApprovalDecision 的过期/失效拒绝是上面已定义的显式特殊规则，不因此放宽。补充测试应覆盖成功重放不新增交接/Run/ProjectBinding、新命令被旧输入/批准阻断，以及撤权后原命令被拒绝。

状态文件必须表达每个状态（包括空后继终态），以及 outcome_unknown 的特殊对账动作；不是测试中复制另一份枚举。跨对象规则必须配可执行参考模型与负向场景，明确该模型是契约验证参考而非生产授权引擎。

## 6. Runtime 协议

Runtime 主动出站连接至 `/api/bot/v1/runtime/ws`，transport 使用独立节点凭据认证并绑定 nodeId 与 spaceId，不能复用客户端自报身份。该 WSS 握手边界在 OpenAPI 的升级说明中声明，消息验证由 Runtime schema 承担。独立 protocol=`devclaw.bot.runtime`、schemaVersion=1。Envelope={protocol,schemaVersion,messageId,type,body}；body 为按 type 严格判别的封闭对象。拒绝外层版本错误、未知类型及 type/body 不匹配。

| type | body |
| --- | --- |
| register | nodeId, provider, capabilities（modes:ModeRef[], capabilities:上述枚举[], recovery:same_node_checkpoint / none, maxConcurrentRuns） |
| registered | nodeId, connectionId, heartbeatIntervalSeconds, serverTime |
| heartbeat | nodeId, connectionId, activeAttempts[{runId,attemptId,fence}], sentAt |
| prepare_workspace | requestId, runId, attemptId, workspace:WorkspaceSpec, grant:GrantRef, lease:Lease |
| workspace_prepared | requestId, runId, attemptId, workspaceRef, inputDigest；不报告本机绝对路径 |
| start | run:RunSpec, lease:Lease |
| accepted | runId, attemptId, leaseId, fence；只确认接收，不表示成功 |
| cancel | runId, attemptId, leaseId, fence, reason |
| inspect | requestId, runId, attemptId |
| inspection | requestId, runId, attemptId, status, lastEventSeq, fence, checkpointRef? |
| resume | run:RunSpec, lease:Lease, checkpointRef；仅 same_node_checkpoint、同 Provider 兼容版本且旧执行已确认停止 |
| event | eventId, nodeId, runId, attemptId, eventSeq, leaseId, fence, authorizationVersion, occurredAt, eventType, data |
| ack | eventId, runId, attemptId, eventSeq；是持久化后 ACK |
| error | requestId, code, message, retryable；不传秘密 |

`inspection.lastEventSeq` 是已确认事件的高水位，范围 0..9007199254740991；0 明确表示尚无事件。实际 event/ack 的 eventSeq 仍从 1 开始，不伪造第 1 条事件来表示空状态。inspection.status 使用 RunAttempt 的状态枚举。

重复投递 start 必须复用同一 Run/Attempt/lease/fence。恢复执行不同于重复投递：只有在 Run 仍为非终态、旧执行确已停止、结果未知已对账且获准恢复后，才创建同节点的新 Attempt、分配更高 fence 和新 lease，以兼容的 checkpoint 发送 resume；Run 的输入快照不能随之改变。已成功、失败或取消的 Run 不能借 resume 回退；另起执行须走新的获准命令。仅仅重连不能重新执行工具。

eventType/data 判别：progress={summary}；waiting_approval={approvalId}；artifact_committed={artifact:ArtifactVersionRef}；completed={outcome:succeeded/failed/cancelled/outcome_unknown, artifactVersions[], errorCode?}。普通进度不能伪装完成，已提交 artifact 引用必须存在且属于同 Task。业务事件 Event={eventId,spaceId,seq,occurredAt,kind,taskId?,runId?,entityRef}，kind 为 task_updated/artifact_committed/approval_updated/run_updated/delivery_updated；只携带授权后可见的引用，读取正文另行鉴权。

接收方核对连接身份、Run/Attempt/Node 绑定、leaseId、未过期 lease、fence 与 authorizationVersion；客户端自报字段不是可信依据。事件以 `(spaceId,runId,attemptId,eventSeq)` 去重，相同 key 不同内容报冲突；eventId 也须唯一。缺口请求补发/inspect，不把后到事件按到达时间当真相。ACK 丢失重发同 Run/Attempt，不启动第二次执行。

服务端 lease 与本地 Thread/工作区互斥叠加；租约失效应停止新增副作用，控制端拒收旧 fence 写入。不承诺仅靠 fence 就撤销已经发往外部系统的操作。

## 7. 必须可执行验证的场景

每条写命令/读取响应/Runtime 变体至少一个正向 fixture；每个关键边界至少一个负向。测试报告区分结构、参考模型和真实系统测试（本轮没有后者）。

1. 未知字段、伪造 actorId、原文 token/authorization/endpoint/path 字段、无效时间/摘要/版本、未知模式/能力、Envelope 判别错误。
2. 同一主体命令重放得到原结果；同 ID 异操作/路径/载荷拒绝；另一主体/空间不能拿回回执；重放前撤权拒绝；CAS 冲突无部分写入。
3. 输入版本变化使旧批准失效；过期批准、非指定批准人、业务签字充当工具授权均拒绝；不同版本同 artifact 不可冒名替代。
4. Upload 未 committed、跨 Task 或 purpose/kind 不匹配时不能创建成果；重复 complete 幂等；已正式提交版本不被第二次 upload 覆盖；baseVersion/CAS 冲突不可最后写入覆盖。
5. RunSpec 不能作为公网 CreateRun 请求越过解析；能力为各方交集；节点离线返回 waiting_node/CAPABILITY_UNAVAILABLE，不宣称执行成功。
6. start ACK 丢失重复派发只产生一个 attempt；旧 fence/过期授权/伪造节点事件拒绝；事件重复同内容幂等、异内容冲突、序号缺口可检测。
7. 取消与完成竞态、未知副作用后不自动重跑、节点离线不立即迁移、resume 能力不足拒绝。
8. Delivery 失败后的重试只变 Delivery；Task 的完成不能由单个 Run 回答自动触发；双确认后开发交接重复命令只生成同一个交接包。
9. TS 类型生成 --check；对非法 schema 关键字显式失败；所有 endpoint refs、响应状态和 fixtures 一致；原 IM V1 测试继续通过。

不得为了“绿色测试”把语义负向场景仅做静态字符串匹配，也不得声称参考模型通过意味着 MySQL/S3/Runtime 已满足分布式语义。
