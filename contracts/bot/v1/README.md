# DevClaw Bot v1 契约

此目录是 F03 冻结的语言无关接口与离线验证，不是已部署的服务。Group 独立于招乎群与 Thread；Bot 是版本化领域上下文，不是 Runtime。现有 IM V1 未修改。

## 唯一来源与消费

- `schemas.json`：JSON Schema 2020-12 的实体、API 请求/响应、Runtime 消息字段定义。所有对象封闭，文本/数组有界，不接受请求自报操作者、原文 Token、任意 URL 或本地绝对路径。
- `state-transitions.json`：8 类状态的唯一枚举、普通边、仅对账可走的特殊边及模式能力上限。Schema 的状态字段直接引用这里，类型生成和参考模型消费同一文件。
- `openapi.json`：OpenAPI 3.1；25 业务 operation 和独立节点凭据 WSS 握手。DTO 只引用主 Schema，HTTP 错误码/状态映射在 `x-error-status`。`.invalid` URL 是不可联网的契约标识，不是可用服务。
- `runtime.schema.json`：仅引用 RuntimeEnvelope；14 种消息及 event 的 4 个 data 变体严格判别。inspection 高水位可为 0，真实 event/ack 从 1 起。
- `../../../src/shared/bot/contracts.generated.ts`：离线确定性生成，不手工编辑。TypeScript 表达结构/枚举/判别联合；长度、数字界限、日期、摘要和跨对象语义仍须运行 Schema/服务端验证。

Java 消费者应使用支持 JSON Schema 2020-12/OpenAPI 3.1 的工具从同一来源生成 DTO，并处理 oneOf 判别和封闭对象；本轮**没有生成或编译 Java DTO**，没有验证 Java 工具链。不能降为 Swagger 2/OpenAPI 3.0 后静默丢失约束。

## 本地命令（Node 22，全部离线）

```sh
node scripts/generate-bot-contract-types.mjs
node scripts/generate-bot-contract-types.mjs --check
node tests/bot/check-contracts.mjs
```

对应 npm scripts：`generate:bot-contracts`、`check:bot-contract-types`、`test:bot-contracts`。单一检查入口使用相同 `process.execPath` 运行所有子进程，不依赖系统 Node 25，也不执行安装/网络访问。Ajv 8.18.0、ajv-formats 3.0.1 是已有解析版本的固定直接 devDependency。

生成器只支持明确实现的闭合对象、有限数组、标量、const/enum、离线 `$defs` 引用、oneOf/allOf 和已列出的约束子集；支持成对的对象 if/then 属性/required 精化，运行 Schema 执行其条件约束（TypeScript 仅保留结构类型）。未知关键字、未知 format、不支持的关键字位置、开放 map、远程/越界引用都失败，不生成 any。`--check` 只比较，不覆盖漂移文件；真实 CLI 临时树测试验证了失败返回码。

## fixtures 与参考场景

`fixtures/positive.mjs` 是共享合成字面量数据模块，覆盖每条 operation 的实际 path/header/query/body 与成功响应（含 upload complete 200/202、WSS 101），每个声明错误响应状态复用真实安全错误样例；另覆盖 14 Runtime 类型、4 event 数据变体、4 completion outcome、inspection 0/1 及三类批准。没有真实凭据。

`fixtures/negative.mjs` 加 runner 的逐请求身份/Token/未知字段注入，真正调用 Ajv 拒绝无效对象。测试检查所有 refs 离线可解、operationId 唯一、DTO 不在 OpenAPI 重写、fixture/响应状态/枚举一致。

`tests/bot/reference-model.mjs` 是独立内存参考模型；测试实际执行命令与状态变化，不只匹配字符串：

1. 结构闭合、版本/日期/摘要/能力及 Runtime 判别。
2. 空间与已认证主体命令范围、规范 method/path/body 指纹、撤权重放、回执先于当前 CAS、失败无部分写入。
3. 准确输入版本/摘要、指定批准人、期限/撤权、三类批准不互替、输入更新失效。
4. 实际上传字节摘要/长度、verifying 与 committed、Task/purpose/kind 绑定、immutable 成果、baseVersion/CAS。
5. 服务端解析 RunSpec；主体、Bot、Group/Task、模式、节点及批准的能力交集；缺少能力显式拒绝，离线只等待。
6. start/ACK 丢失复用同 Attempt；身份/lease/fence/授权版本、重复事件冲突、eventId 唯一、序号缺口、持久化后 ACK。
7. 取消完成竞态、未知副作用对账前禁重跑、离线不迁移；恢复需旧执行已停、未知已对账、兼容同节点 checkpoint、新 Attempt/lease 与更高 fence，输入不替换，终态不回退。
8. Delivery 失败仅重试通知；Run 不自动完成 Task；双确认交接不创建项目/Run；一致快照与增量 cursor、当前权限过滤、过期要求重同步。
9. 类型生成实际 CLI 漂移/非法关键字检测与 tsc 正负消费；原 IM V1 回归由完整交付报告记录。

参考模型的身份/授权、批准人配置、节点连接、存储验证与外部停止/对账证据由可信测试 harness 提供，**不是生产授权引擎**。证明停止/对账的布尔值仅用于合成测试，不是新增的公网或 Runtime DTO 字段。

## 重要边界

上传 purpose 复用 ArtifactKind，只声明用途，不授予成果写入权限；Artifact 只接受同 Task、已 committed、purpose 与 kind 相等的 Upload。首版上传/下载是鉴权二进制代理，不给模型 S3 URL。If-Match 仅允许一个双引号内无前导零的正十进制安全整数强 ETag（如 `"1"`）；拒绝 W/、_、列表及越界值，接收者还验证解析后的 Version。PUT 的 mediaType 来自实际 HTTP Content-Type，必须是无参数、无空白的小写 MediaType，且与 UploadSession.mediaType 一致；OpenAPI 的 _/\* 范围允许已声明文件类型，`x-request-headers-schema` 和 runner 明确校验四个契约相关 headers，并非只收 octet-stream。下载传输类型独立保持 octet-stream。

二进制指纹按空间/已认证主体、method、规范 path、真实字节 SHA-256、实际 Content-Type 与 If-Match 计算，排除 X-Command-Id；同 ID 改字节、类型或 ETag 是冲突。当前鉴权先于回执查找，原回执先于新写 CAS；实际字节大小限制对重复请求仍适用，不盲信客户端摘要。HTTP header 名称由服务端按大小写无关规则提取，fixture 使用规范名称；Authorization 等传输头不作为客户端身份 DTO。

成功 DevelopmentHandoff 的原 commandId/原载荷在当前仍有任务/回执读取权限时返回原不可变回执，即使 PRD 已更新、批准已失效或 CAS 变化；不再创建交接、Run、ProjectBinding。新 commandId 仍执行最新输入与双确认门禁；撤权拒绝历史重放。ApprovalDecision 过期/失效拒绝是独立显式特例，不因交接重放规则放宽。

参考模型对所有 expiry/deadline/lease/command/cursor/approval 按实际 UTC 纳秒精度比较（schema 可接受1～9位小数秒），等于期限即失效；无法表示的时间拒绝而不放行。多对象迁移在克隆事务中执行，拒绝时状态、证据和 ID 计数不变。Delivery 读取/重试经 Run/Attempt 解析当前 Task/Group/空间和资源权限；未知投递结果须先对账，重发不新建执行。显式 workspace.write 必须同时满足冻结和当前服务端 WorkspaceSpec.access=write，create/dispatch/resume 均复核；这不把所有 command.execute 一概新增为写权限请求。

ThreadBinding/ProjectBinding.provider 是不透明 ProviderId（同 Id 格式），仅供有权服务端适配器写入。格式正确不代表 provider 存在或已获准，也不允许客户端任意注册适配器。RuntimeNode/register.provider 的 desktop/hosted 仅表示部署类型。

批准固定输入的 artifactId、versionId、digest；输入变化不覆盖旧成果、旧交接或在途 Run 快照。业务/技术批准不代替工具授权。unknown 副作用不能标为自动可重试；fence 不能撤回已经发生的外部操作。

本轮**未验证真实 HTTP/WSS、MySQL 事务/Outbox、S3 不可变、ES、Runtime 进程、节点停止、真实模型、真实内网、生产授权或跨进程重启恢复**；没有生产 exactly-once 保证。下一阶段必须在批准技术栈与真实资源上独立验证这些边界。
# B01 Java typed consumption (A2a)

`scripts/generate-bot-java-contracts.mjs` derives only the six Bot/Group operations' request, success/error, header and path schema closure from these frozen documents. Its Java8 output is `services/bot-control/src/main/java/com/devclaw/botcontrol/contracts/BotContracts.java`: closed POJOs, wire-valued enums, `Long` integers and typed lists/consumer signatures. The generated header hashes exact source bytes; `--check` compares without writing and rejects drift. Unknown reachable keywords, nonlocal references, open objects and unsupported shapes fail before output is written. Task/Run/Runtime types are outside this slice.

Optional null fields are omitted; required fields remain represented. DTOs are structural consumption types, not runtime Schema validation, null/range/conditional enforcement, permissions or a running HTTP service. Original Schema validation and Java/Ajv parity belong to A2b. Run `npm run test:bot-java-generator` with Node22 and `npm run test:bot-service-build` for the isolated real-JDK8 compatibility/consumption build. The build checks drift and never regenerates silently.
