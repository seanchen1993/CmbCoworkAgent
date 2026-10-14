# 模型 SDK 新结果协议兼容评审

状态：设计已通过双评审并完成本轮生产实现，最终集成验收见后附记录。初始核查基于当前源码、2.1.283 二进制内嵌声明及实际宿主实现，随后已补查 2.1.284 内嵌声明。公开 tag 的 283/284 声明完全相同，SHA256 为 `6D19C8250D22358C8527189274D96F9F862C30C8650C92030359AA407A01DEA2`，不能据此推断二进制运行协议相同。

## 为什么必须区分模式

当前 `FunctionModels.complete` 返回字符串，`FunctionSession` 的操作结果和 SDK 返回两处均按字符串验证；`fork` 返回 `{text, usage?} | null`。已交付的 review-agent 和 Autobiz 示例直接使用字符串。上游 283 内嵌声明及 `chunk-3jyp964r.js` 的 `dxe`/`sbt` 已返回 `isAnswered` 联合类型，成功、API 错误、空回复、取消都带四字段 usage，冷会话 fork 返回 `nothing-to-fork`。直接替换宿主返回值会破坏已安装插件及观察器。

## 明确的清单和迁移契约

建议采用本工程扩展字段（不声称这是上游已有清单字段）：

```json
{
  "cmbCompatibility": {
    "modelProtocol": "result-v1"
  }
}
```

- 无此字段一律为 `legacy-v1`，包括已安装的 Claude 格式包。不得凭下载时间、文件名、调用源文本或当前宿主版本自动切换。
- 可用值严格限定 `legacy-v1` 和 `result-v1`；未知键/值拒绝。原生包放在 `mods/manifest.json`，Claude 格式包放在实际 plugin manifest。两个位置同时声明直接拒绝，避免优先级歧义。
- `CompiledFunctionPlugin` 和 `FunctionPlugin` 增加宿主可信、只读 `modelProtocol`。规范化值进入编译摘要；原始 manifest 仍在 captured sources 内。清单变化必须重新批准，也使已绑定 Claw 旧摘要失效。不要把模式放入可变 `register(options)` 或模型请求参数。
- 新导入上游包若需要新协议，作者明确声明，或将来导入 UI 明示转换并保存受摘要保护的安装元数据；本轮不需要做自动迁移。导出清单和诊断必须显示实际模式。
- 全局 `CLAUDE_MODS_PROFILE` 不应直接改成“284完全兼容”。此处只是模型协议版本，其他事件仍有已披露差异。

## 一次调用的链路冻结

SDK 调用进入 `FunctionSession.scopedCapability` 时，从调用者的宿主 `FunctionPlugin` 取模式，固定在本次 operation 的内部元数据中；不能从 guest 的 `input`、`next(e)` 或任何结果字段读取模式。

`FunctionDispatcher.dispatch` 已按 tier 和 registrations 建立链快照。建议加宿主 `validateChain` 回调：建立最终快照后、任何 matcher/handler/模型请求之前，核对 `model.complete` / `model.fork` 链中每个潜在观察器的协议与调用者一致。通配 `model.*`、`*` 同样参与。忽略本来就在 skip 范围内的当前 registration，其余不按 matcher 的运行结果或 `next.to` 预测绕过。冲突抛出 `MODS_MODEL_PROTOCOL_CONFLICT`，列出事件、调用者、冲突插件及模式，不包含输入文本。

这是保守但可审计的首版：不同协议的插件可以共存，只要不会在同一模型操作链上混用观察器。禁止静默跳过不兼容观察器，因为它可能承载用户校验；禁止把未知错误/空文本自动转换成“成功”来让旧观察器运行。组合页面可预检潜在冲突并明确引导用户统一模式。

该检查必须在 dispatcher 的 optional-hook recovery 之外执行，不能变成“hook失败后继续core”。validateInput / validateResult、核心结果转换、SDK最终返回均读取同一冻结模式。嵌套独立 `$` 调用按实际发起插件固定新的模式，但不能改父调用模式；reload/revoke 沿用原有 session epoch、grant 检查。

## 宿主内部数据和安全边界

保留统一宿主结果，但将“实际 provider 结果”和“guest 展示结果”分开。内部可以保存 text、provider分类/HTTP状态、raw reported usage、是否未知、输出已保护状态。外部结果仅转换已保护的内容，不能暴露原异常消息、请求体、地址或凭据。

- legacy 路径继续返回原字符串、fork 的 null/旧对象；不改变既有异常语义。
- result-v1 成功返回 `{isAnswered:true,text,usage}`；失败枚举需白名单，冷快照返回 `{isAnswered:false,reason:"nothing-to-fork"}`。
- provider 网络/API错误才映射 `api-error`，只带安全分类和有限状态码；无文本映射 `empty-reply`。宿主授权、配额、撤权、摘要变化、内容保护拒绝、格式/结果超限仍必须 fail-closed，不能转成可被 after-hook 改写的普通 provider 结果。
- 仅独立请求超时且父 authority 仍有效时可发布 `aborted`。整个 turn/session 已取消或撤权后沿用宿主禁止发布的规则；不能为了模仿上游结果绕过 `assertLive`。此项必须在兼容说明中保留为 desktop 差异。
- 上游内嵌 `ModelUsage` 明确缺失字段显示零，因此外部四字段补零可对齐；内部预算和审计仍必须保留“provider未报告”，按当前保守结算，不能拿展示层的零覆盖真实未知成本。provider 的输入总量与缓存计数口径需分别归一，不能盲目将总输入当作 uncached 输入再加一遍缓存。
- after-hook 可按现有操作契约替换用户看到的结果；真实调用 usage/模型路由/审计必须继续取 provider 记录，不信任返回值。新联合类型每个 arm 严格检查字段、有限非负整数、大小和错误枚举。

## 输入控制和成本

新版 `complete` 增加 `effort` 与 `timeoutMs` 时要贯穿 parser、hook重写后复核、最终 admitted input、provider adapter 和取消清理。effort 不得只校验后丢弃；不支持的 provider 按已定义能力策略处理并说明。timeout 取用户请求与宿主最高期限的较小值，保留宿主配额。原有 256 默认、4096上限、60秒上限若保留，仍为适配差异；不能仅加新返回对象就宣称完全对齐。fork 的 maxTokens 是现有扩展，新协议公开参数以 prompt-only 为目标，旧模式保留扩展。

实际改动主要落在：

1. `shared/mods/v2/contracts.ts`、`v2/loader.ts`、`v2/manager.ts`：解析、摘要和可信模式传递。
2. `v2/dispatcher.ts`：快照链预检，不改变其他事件调度语义。
3. `v2/session.ts`：operation 元数据、参数/结果校验、SDK返回与 host 接口联合类型。
4. `v2/model-sdk.ts`、`model-operations.ts`、`models.ts`、`model-provider.ts`：内部结果、provider错误分类和 usage 传递、请求控制。
5. author types/devtools、兼容矩阵和示例说明；若补UI诊断仅显示可信元数据，不让输入伪造模式。

成本为中等跨层协议迁移，不能只改 provider 一个文件。复用既有隔离、调用权限和账本，不新增一套模型运行时。

## 必须通过的回归

- 无声明旧包、显式legacy、新协议包；非法模式、双声明；模式变化使旧grant/Claw绑定失效。
- 旧complete字符串/fork null、新complete和fork所有结果arm；未知usage的预算仍保守；缓存计数真实传递。
- 同模式before/after/multi-next；跨模式exact/wildcard观察器在任何模型/handler副作用前拒绝；matcher false或next.to不能绕过；嵌套新调用不污染父模式。
- 冷会话零provider调用；API错误安全分类；超时真实取消且无重试；撤权/内容保护仍throw、迟到结果不发布。
- 真实QuickJS插件与本地受控模型transport联合测试，不能只mock FunctionModels；已交付Autobiz/review-agent旧包继续可用。
- 未绑定、Mods关闭、旧Plugin/Harness普通请求不受这个显式SDK协议影响。

结论：采用显式摘要绑定和整链预检后可实施；在协议迁移、provider错误与宿主拒绝分流、真实usage结算三个前提未落实前，不通过直接替换字符串/null结果的方案。

## 实现复核记录

2.1.284 内嵌声明 `readable/claude-code.d.ts-c417f0db.txt` 已核查：完整联合结果、四字段 usage 保留，新增 `model.complete(request, options?: {signal?: AbortSignal})`。本轮没有实现该第二参数，也没有接受后丢弃 `effort`；effort 明确报 `MODS_MODEL_EFFORT_UNSUPPORTED`。不能写作“284模型 API 完全兼容”。

实现使用 additive `completeModelResult` / `forkModelResult` 宿主接口，旧接口不改。无声明 legacy 的摘要算法保留，避免纯宿主升级使旧包全部失效；新清单值仍进入 captured manifest 与 result-v1 规范摘要。CLI 检查报告和按目录导出的类型均读取编译快照中的协议。作者使用说明见 `mods-model-result-v1-authoring.md`。

独立实现复核发现并修复两项：显式 `null` 清单值被 `??` 吞掉；optional recovery 中的下游协议冲突被 fallback 吞掉。均补了反例回归。生产修改未涉及主聊天模型运行方式、旧 Plugin/Harness 或 HTTP 实现。

已取得的证据：

- 首轮模型定向 5 文件 81 项通过，见 `output/mods-model-protocol-narrow.log`，包含真实 QuickJS → 宿主 → 受控 SSE 模型、保护后结果、缓存 usage、500脱敏、超时断连且仅一次请求。
- 新增协议 9 项与既有 conformance 15 项合计 24 项通过，覆盖 nested engine.create provider 使用自身协议、父调用不污染、恢复处理器冲突不吞掉。
- 第二位评审独立跑 protocol/conformance/loader 与 fs/HTTP 共 96 项通过，并报告两项修复闭环、无新增生产阻断。
- Node 类型检查通过；定向 ESLint 0 errors，剩余格式 warnings 单独记录，不以整体格式化大文件扩大改动。
- 扩大到 10 文件的首轮为 165 通过、20 个 5 秒超时，无功能断言失败；原始结果保留在 `output/mods-model-protocol-final-narrow.log`。当时主线程也在全量测试，不能把并发资源竞争直接定性为功能通过，后续受控全量已复核，结果见下一条。该轮中现代热 fork 保护/缓存/释放、真实 unknown budget 与账本两项新增回归均通过。

- 最终主线程受控 2 worker 全量覆盖 679 文件：5426 通过、11 个既有失败、5 跳过。全部失败 fullName 与历史基线一致，`output/claude-code-2.1.284-analysis/baseline-comparison.json` 的 `newFailures=[]`；此前并发超时未复现，Node/web typecheck 通过。

当前结论：设计与已检视生产实现通过，扩大回归的并发超时已完成受控复核；构建和 Electron 验收引用主线程最终交付记录，不把上述单测等同于 Electron 验收。
