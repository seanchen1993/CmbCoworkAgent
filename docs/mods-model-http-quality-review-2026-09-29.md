# 模型协议迁移与 HTTP 解压：第二质量评审

评审者：composition_quality_review（独立于实现者）。
结论：**方案与实现独立复核通过；下述两项审查发现已修复，定向独立复验 134 项通过。**
最终打包与 Electron 验收由根任务统一执行，本报告不将尚未运行的检查记为通过。
本轮补模型 SDK 新旧协议、HTTP 压缩响应及 fs.list 时间戳，不将 skill.prompt 计入完成。

## 实现复核记录（2026-09-29）

独立检查了 loader → immutable plugin → session operation → dispatcher → models →
provider → host-call 的完整链路，以及 HTTP transport、文件 metadata 与可用性 catalog。
284 二进制内嵌声明已提取；公开声明陈旧的事实没有被用于夸大兼容度。

审查中找到并要求实现者修复两个真实问题，均已读回修复并独立运行回归：

1. loader 用 `??` 选择声明来源，会将 Claude package 中明确的
   `cmbCompatibility: null` 误当未声明、退回 legacy。现用 `!== undefined` 选来源，
   null 交给严格 parser 拒绝；真实 compile fixture 证明失败，不只验证 parser。
2. dispatcher 的 optional recovery 原先无条件吞掉 catch-handler 的错误；catch 内
   调用冲突模型链时，带 downstream 标记的协议错误会被吞掉。现恢复阶段也保留
   downstream / cancellation 异常。真实 QuickJS 主 handler 抛错 → 注册 catch 调模型
   的测试验证冲突抛出且 provider 零调用；原 conformance 15 项保持通过。

未发现剩余生产阻断。具体核对结果：

- 模式来自宿主快照；模型链在 matcher / handler 之前检查；engine.create 自定义 noun
  内部模型调用仍按实际 provider 插件模式执行，不污染父调用。未声明旧包保留原摘要
  算法，显式模式及原始 manifest 仍参与源码身份，避免升级时无故失效全部旧授权。
- provider 分类限制在实际模型适配器，原异常正文不进入联合结果。宿主拒绝、权限、
  输出超限、撤权与内容保护仍抛错；独立 timeout 和父取消分别处理。
- 账本与 completion budget 使用 provider 原始总 usage；外部四字段补零、缓存口径
  转换和 after-hook 结果不改写实际费用。host-call 在异步边界和发布前后重检权限。
- HTTP wire / decoded 各自计数，decoded chunk 超限前不保存；pipeline 保持背压，
  finish 先固定结局再销毁全部流，防止 decoder 后发错误覆盖原撤权错误。
  空体和重定向不启动无意义解压；每跳授权、跨源 header 限制和发布围栏保留。
- fs.list 复用每项一次 bigint lstat，与 fs.stat 精度一致；regular file 用自身时间，
  目录/链接/其他类型为零，不跟随链接。旧 hook 可省略字段，有值须有限 number；
  历史负时间戳合法。catalog 仍将这些功能列为 bounded，skill.prompt 为 unavailable。

独立 fresh 测试（Node 22）：

- `output/mods-model-http-independent-review.log`：6 文件 96 项通过，覆盖 protocol、
  conformance、真实 loader、file metadata、HTTP transport / QuickJS integration。
- `output/mods-model-provider-independent-review.log`：4 文件 38 项通过，覆盖 models、
  provider、operations、model boundary；包括真实 QuickJS → 本地 SSE provider、
  内容保护、缓存 usage、API 失败、空回复、超时连接关闭与不重试。
- HTTP 实现者另有 fresh 45 项及定向 lint / Node typecheck 通过日志，分别为
  `output/mods-http-compression-tests.log`、`output/mods-http-compression-lint.log`、
  `output/mods-http-compression-types.log`；这部分为检查日志，非冒充独立运行。

后续冻结测试仍由根任务负责；以下设计验收条款继续有效。这里的通过是本轮限定实现的
质量结论，不代表整个 Claude Mods 已完全对齐。

## 评审依据

- `docs/mods-model-protocol-migration-review-2026-09-29.md`。
- 当前 `v2/models.ts`、`model-sdk.ts`、`model-operations.ts`、`session.ts` 和 `http-sdk.ts`。
- 2.1.283 内嵌声明中的 ModelCompleteResult / ModelForkResult，以及已提取操作实现。
- 公开 2.1.283 / 2.1.284 声明哈希相同，不能替代 2.1.284 内嵌运行时核对；最终冻结
  前补齐该证据。方案不宣称全量 Claude 协议兼容。

## 模型协议：通过

显式 `cmbCompatibility.modelProtocol` 是合理的本工程迁移扩展。无声明保持 legacy-v1，
避免旧插件将新对象显示成 `[object Object]` 或将冷 fork 的失败对象误当成功。
模式进入不可变快照和授权摘要，并在整条 operation 中冻结，比请求参数或调用文本推断可靠。

实现验收必须满足：

1. 原生/Claude 清单严格校验；两处重复声明、未知字段和值拒绝。模式变化撤销旧源码授权，
   既有 Claw 绑定不能悄悄继续使用新协议。类型导出和兼容诊断显示真实模式。
2. 混合模式模型观察器冲突在最终链快照建立后、任何 matcher/handler/provider 执行前报错。
   exact、wildcard、matcher false、next.to、嵌套调用都必须覆盖；不得在 optional-hook
   recovery 中吞掉冲突或静默跳过一个可能承担策略检查的观察器。
3. 权限、配额、输入格式、撤权、来源变化和内容保护错误仍抛出；只有实际 provider
   的 API/网络失败、空回复和仍有活跃父权限的独立请求超时才转换成结果联合。
   turn/session 已取消时继续禁止发布，明确记录与上游 aborted 结果的适配差异。
4. 成功正文在 after-hook 前保护；API 错误只暴露受限分类/状态码，不含异常原文、URL、
   请求体或凭据。每个结果 arm 严格验证，允许空文本的规则按固定协议落实。
5. 外部 usage 缺失补零仅供兼容展示；真实 provider usage、未知成本、配额预留和账本
   结算分开。after-hook 修改结果不能修改真实费用；缓存 tokens 不与总输入重复累加。
6. effort/timeoutMs 如果本轮加入，要贯穿重写后参数复核、批准记录及真实 provider请求。
   保留的 maxTokens/默认值/最长时间等适配上限如实披露，不能据新返回结构声称完全对齐。

必须证明旧 complete 字符串、旧 fork null/对象完全保留；新协议各 arm、同模式多次 next、
跨模式零副作用拒绝、冷 fork 零 provider、provider错误脱敏、超时取消不重试、撤权和
内容保护 fail-closed、并发配额与资源释放。至少一条真实 QuickJS→受控模型 HTTP 链，
并回检现有 review-agent / Autobiz 旧包和普通 Plugin/Harness。

## HTTP 压缩响应：通过

宿主固定发送 `Accept-Encoding: gzip, deflate, br`，不允许 guest 借 header 控制解压策略。
只支持单层 identity/gzip/deflate/br，未知或多层 Content-Encoding 明确拒绝。
deflate 按标准 zlib 包装处理；不要用失败后猜测 raw-deflate 的隐式兜底掩盖损坏响应。

实现验收必须满足：

- wire 和 decoded 各最多 256 KiB。Content-Length 只作非空响应的早期拒绝提示，
  实际流计数始终存在；不能只检查 Content-Length 或把压缩后长度当解压长度。
- 采用流式计数与解码，保持背压；每个 decoded chunk 先检查累积上限再保存。
  不先拼接完整压缩 body 后一次性同步解压。UTF-8 转换在字节限额检查之后。
- HEAD、204、304 没有实体，不启动解码器；即使标注 gzip 或代表资源的非零长度，
  不把合法空响应误判为损坏或超限。重定向仍不缓存 body，每跳目标单独批准。
- abort、timeout、decoder error、wire/decoded 超限、来源撤权均销毁 outgoing、incoming、
  decoder 并取消订阅；错误不 publication、不重试、不残留未捕获 error。
- 原每跳授权、跨源敏感 header 处理、JSON 返回大小、内容保护和发布后权限检查保留。
  返回 headers 与 text 的编码含义在文档说明，避免作者对已解压 text 再解压。

必须覆盖三种真实压缩、identity、非 ASCII 跨 chunk、精确 256 KiB 和多一字节、压缩炸弹、
损坏/截断、未知/多编码、空体、重定向不缓存、拒绝零网络、timeout/abort/revoke 零发布，
以及真实 QuickJS 调用链（仅 zlib helper 单测不足以证明插件可用）。

## skill.prompt 的排除是必要的范围控制

本工程显式 Skill 当前发送可信身份标记，实际正文在 LocalSandbox.read 中读取、模板替换、
分页和行号格式化。上游 skill.prompt 的 text 是完整扩展正文。把标记或带行号片段作为
该事件输入会造成假兼容；直接追加重写正文又可能与后续读取原文冲突。
它仍应列为下一项，独立设计完整正文快照、真实读取和普通/Flow/subagent 入口的语义。

## 最终把关

本次结论批准设计，不预先批准尚未产生的实现。完成后需两位独立复核，重点检查协议冲突
是否可被 matcher/recovery 绕过，以及 provider错误是否错误吞掉宿主拒绝。
冻结后跑类型检查、构建、定向单测、真实进程/QuickJS/Electron 与旧功能回归；基线失败
逐项对照，未执行项不能记通过。无需为此改写用户既有插件或自动升级其协议。
