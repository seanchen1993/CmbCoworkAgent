# 遗留失败逐项独立确认（2026-09-26）

补充：主 agent 随后已修复本文 registry 和 sandbox #36 两处正式测试接线。registry 43 项通过；sandbox 窄测通过，完整 85 通过、2 个原有失败。其他 output 诊断结果仅用于归因。所有证据文件位于 `output/mods-v2-validation/`；当前汇总结论见[逐项确认与启动修复](mods-v2-confirmation-and-dev-repair-2026-09-26.md)。

审查者：独立兼容评审 agent。范围：`C:\ai\CmbCoworkAgent-mods-v2` / `codex/mods-v2`。只读产品源码；本审查仅在被忽略的 output 目录写入诊断文件。未触碰 UAT、package-lock、依赖、产品代码或正式测试。Node 为指定绝对路径的 v22.23.2。

结论：26 个 Vitest 失败不是一个原因。21 项的具体原因已用不改产品的测试假设诊断确认；5 项是缺失浏览器扩展源码导致的验证缺口。4 个 standalone 失败命令中，agent-registry 及 sandbox 的一个子项确定由 Mods 重构后静态测试未同步造成；其余分别是原有静态正则过时、Windows 路径和 IM 回复格式契约变更。不能统称“无关旧失败”，也不能把 output 中的诊断通过写成正式全仓测试已通过。

## 证据与口径

- 原始全仓记录：`2026-09-26-review-final-vitest-comparison.json`，4781 项，4749 通过、27 失败、5 跳过；其中原26项加一项 git-panel 超时。
- 原始独立命令记录：`2026-09-26-review-final-standalone/results.json`，84 命令79成功5失败；其中4原失败和新测试标题触发的 im-clean-cut 扫描。
- 原样窄测：`2026-09-26-existing-failures-independent.json`，9 个相关文件的81项，54通过27失败；复现原26项，另首个 browser script 用例出现 STACK_TRACE_ERROR、持续8862ms。该用例的断言未修改，之后诊断重跑通过；不能仅凭此断定确定性产品回归。
- 原因验证：`2026-09-26-existing-failure-hypotheses.config.ts` 只在 Vitest 转换阶段替换测试假设，不改产品/测试文件。最终 `2026-09-26-existing-failure-hypotheses-complete.json` 七文件76/76通过。它确认了21项原失败的可解释原因，不是正式验收结果。
- 独立 IM 诊断：`2026-09-26-im-remote-hypothesis.ts/.log`、`2026-09-26-im-local-hypothesis.ts/.log` 为 output 克隆，调整相对导入及明确过时的预期。两套完整执行通过。未禁用权限、审批单次性、超时和会话路由检查。
- 本文所列“最小处理”是建议，除主 agent 后续明确实施外仍未进入正式源码。

## 26 项 Vitest 逐项

下表保留原顺序；对应完整英文测试名及原失败堆栈见 comparison JSON。分类是失败本身的原因，不能推导所有同类产品行为均无缺陷。

|序号|具体失败|分类与证据|验证、最小处理|
|---|---|---|---|
|1|browser script 相对 upload 路径|Windows 测试假设：测试324行写死 `/tmp/workspace/think.webp`，产品实际 native resolve 为 `C:\tmp\workspace\think.webp`|测试预期改用 native `resolve(workspace,file)` 后整套7项通过；无需改产品路径边界|
|2|human_gate：APP 完成失效 IM 码|旧命令提取：setup403行匹配 `/门禁批准`，adapter40行发送 `/批准推进阶段`，setup405在生命周期断言前失败|只修setup提取为当前公开命令后此项通过；保留单次消费断言|
|3|human_gate：IM 完成移除 APP pending 并拒绝重复|同上，未进入实际断言|诊断通过；保留重复 IM/APP 决策拒绝|
|4|human_gate：拒绝其他用户/会话且保留正确码|同上|诊断通过；保留 principal/conversation 隔离|
|5|human_gate：临时拒绝可重试并给域原因|同上|诊断通过；保留重试和原因断言|
|6|human_gate：运行时失效清理码|同上|诊断通过；保留无持久结束事件分支|
|7|human_gate：outbox 失败清码且 APP 仍可操作|同上|诊断通过；保留插入失败及APP有效检查|
|8|human_gate：关闭 IM 失效码且 APP 可操作|同上|诊断通过；保留关闭行为检查|
|9|human_gate：发送临时失败保留已排队码|同上|诊断通过；保留重试保码检查|
|10|human_gate：重启失效且不重发|同上|诊断通过；整份 notification-pipeline 32项通过|
|11|IDE：macOS 工作区/文件后定位行|不完整平台 mock：仅改 process.platform；真实 Windows 文件系统没有 `/Applications/WebStorm.app`，且 path.join/normalize 仍为 win32|限定假 app/binary 的 existsSync mock，darwin 时用 posix join/normalize 后通过；不移除生产 existence 校验|
|12|IDE：后续定位失败保留工作区/文件|同上，原失败发生在 launcher 校验|诊断通过；保留失败降级断言|
|13|IDE：macOS 直接 app executable|同上|诊断通过；保留 spawn executable/参数断言|
|14|IDE：macOS 工作区和文件共同打开|同上|诊断通过；保留参数及 shell:false 断言|
|15|IDE：保存 executable 规范化到 bundle|同上|诊断通过；IDE整套8项通过，其中Windows 3项保持通过。不是对真macOS应用的E2E证明|
|16|cookie bridge：认证失败后断开|Windows socket fixture 错误：测试55行把 .sock 临时文件用作 listen；真实 path helper46行已有 win32 named pipe|仅fixture用随机 `\\.\pipe\...` 后通过；保留认证失败消息/连接关闭断言|
|17|cookie bridge：认证并完成分块 cookie 导出|同上，测试84行|诊断通过；保留分块/完整数据断言|
|18|cookie bridge：取消发送失败仍结算超时|同上，测试160行|诊断通过；整套3项通过，取消异常分支仍执行|
|19|extension popup：Chrome94 手工授权引导|资产缺失：popup测试89行读取 `chrome-extension/popup.js`，当前工作树不存在，.gitignore50行忽略整个目录|未能验证实现。须取得对应版本真实源码或明确外部依赖来源再执行，不得造空fixture/skip假绿|
|20|extension popup：现代Chrome runtime权限|同上|同上；不代表权限交互正确或错误，只确认执行不到待测代码|
|21|extension worker：初连失败重试后 minute alarm|资产缺失：worker测试106行读取 `chrome-extension/service-worker.js` 不存在|同上；保持验证缺口|
|22|extension worker：连接成功后最多3次恢复|同上|同上；不能凭测试未执行判断重试策略正确|
|23|extension worker：手工重连恢复预算|同上|同上；5项缺口应单独列出，非Mods产品回归证据|
|24|artifact reveal：外部预览重新校验|过时静态断言：测试73行要求 `if (externalPreviewGrant)`；RightPanel3097行按 `!resolved.inWorkspace` 分支，动态续 grant，3101无grant拒绝，3105走受控 reveal IPC|诊断改为当前外部路径分支后整套8项通过。正式修复应同时保留/加强无grant拒绝及IPC路径检查，不能只查随意字符串。关联历史58ad8d34 UI修复|
|25|theme：禁止新增固定颜色表面|Windows路径key：test165用 relative 原始反斜杠，allowance keys全为正斜杠；22处既有allowance全部失配|只把relativeFile分隔符规范化为 `/` 后整套16项通过，未改色值或新增allowance；不是22处实际新增颜色回归|
|26|Harness mapping存储上限|过时常量位置：测试33行要求service内声明512；实际context-integrity.ts:2声明并由service57行导入，service2015/2227按2MiB读写、2219检查条数|诊断读取共享常量来源后2项通过；仍保留storage byte/entries检查。历史7bfa4d7a context完整性修复|

## 4 个 standalone 命令逐项

1. `tests/agent-registry.spec.ts`（原40.log）——确定的 Mods 相关测试维护缺口。
   - 520行同时要求 `mainSubagentsEnabled` 和旧一步映射 `const registrySubagentSpecs = mainSubagentsEnabled`。runtime5196仍排除coordinator/leaf；5341先依enabled加载 `registryProfiles` 或空数组；随后 `offerAgent` 只过滤已加载的profiles；5365再map specs。
   - Git证据 `ee7302e5 feat(mods): align agent offers with Claude v2.1.278`。
   - 最小补丁：保留enabled排除条件，严格断言新的 enabled→async load或[]→profiles.map 链路，并保留/检查 `functionMods && registryProfiles.length > 0` 过滤条件。不要为测试恢复旧实现，也不放开 coordinator/leaf。
   - 验收：完整agent-registry独立套件。源码结构断言只能证明接线，现有真实Mods offer测试负责行为；避免把本补丁宣传为完整 createAgentRuntime E2E。

2. `tests/sandbox-elevated.unit.spec.mjs`（原52.log）——三个具体子失败必须拆开。
   - #36 `sandbox-adjacent runtime startup avoids synchronous filesystem probes`：1546开始的sectionBetween寻找已不存在的 `async function ensureCodexExe(`。helper已在 `src/main/agent/codex-sandbox-binary.ts`；runtime160导入、5416在win32 await调用；helper用异步 stat/pipeline/rename/unlink，并发共享pending，未发现新增同步FS。Git为 `6abb89dc test(mods): complete protocol, performance and packaged validation`，明确Mods重构造成测试失配。
   - #36最小补丁：runtime截取范围改 `  let resourceBase: string` 至 `  const baseHooks = getEnabledHooks(workspacePath)`；新读helper并对其全文件执行原forbiddenSyncFs断言；另外断言runtime导入及await调用。原runtime imports和code_exec async候选检查全部保留。这是本轮建议修复项。
   - #46 `workflow notification backlog drains: ack kicks the next pending run`：1843正则要求 `broadcast(threadId, { type:` 在同一行。run-manager1593实际异步查pending并多行broadcast，附带runId/notificationOwner；原正则被格式和额外字段打断。无需改产品；将来正则应容忍空白并保留待处理runId和owner语义，最好用已存在行为测试验证。此轮只确认。
   - #85 `workflow notification is at-least-once...`：2727正则要求claim只传两个参数。agent IPC实际还传 `{ owner: backgroundNotificationOwner }`；run-manager1562先按owner筛选再inFlight集合原子recheck/add，未在claim阶段持久化delivered。Git `c391b184 fix(agent): ownership holds where results are consumed, not just checked`。是归属隔离加强后的旧静态断言，不应删除owner迎合测试。将来更新正则/行为测试必须保留claim owner及成功后ack、失败释放的全部后续断言。此轮只确认。
   - 验收：#36窄测和完整suite，另外两个既有失败原样诚实保留；不得声称整个sandbox套件已绿。

3. `tests/im-remote-approval.spec.ts`（原78.log）——Windows路径展示断言。
   - 测试360/390要求 `src/billing.ts`；`remote-approval-service.ts:119..133`以native relative展示安全相对路径，Windows为 `src\billing.ts`。未出现绝对路径泄露证据。
   - output诊断只将两个预期构造改为 `join("src", "billing.ts")`，整套通过；其他principal/conversation隔离、单次短码、拒绝类型、无绝对路径泄露、审批审计断言都保留。
   - 无需改产品为POSIX，也无需降低安全检查。本轮已确认，正式测试修正可独立排期。

4. `tests/im-local-zhaohu-journey.spec.ts`（原83.log）——Feature项目会话回复契约更新。
   - 667/686期待普通 `【会话：检查 Feature 当前状态】`，但该fixture metadata明确有harnessFeature。remote-runner1100/1403解析project context，reply-context.ts提供 `【项目模式会话返回】` + 项目/特性/阶段/状态格式。project-reply-context.ts数据读取失败降级为stable ids/未知，不改变执行和投递。
   - output诊断将两处旧前缀改为当前项目格式，另外严格检查项目project-pay、特性feature-quick-pay、跨绑定提示及 `/切换 检查 Feature 当前状态`。完整旅程通过，继续包含其他会话并行完成、审批、用户输入等。
   - 实际捕获：`【项目模式会话返回】（非当前绑定会话）`，项目/特性和未知阶段，再提示“回复不会发到这个会话。要继续它，请发送 /切换 检查 Feature 当前状态”。不是回复路由丢失。关联现有IM文案历史f80fb47b/82b468e9，无本轮Mods归因证据。

## 两个原报告新增失败及本轮瞬态

- git-panel首次push未发布提交用例：原全仓5000ms超时；主agent提供原断言/超时未改的隔离复测38通过2跳过，见 `2026-09-26-review-isolated-recheck.log`、`2026-09-26-review-recheck-resolution.json`。只能说该失败隔离未复现，不能宣布全仓重新通过。本轮未重复真实git重测以免与主agent冲突。
- im-clean-cut：源扫描把新增completion-policy测试标题的通用“takeover”判作废弃设备功能。仅两个测试标题改为application ownership change，原扫描不变；当前src已无该词，`2026-09-26-review-im-clean-cut-final.log`通过。这项确实是本轮新测试引入的误触发，已修复。
- 本次原样9文件窄测首个browser script STACK_TRACE_ERROR：8862ms；后续同产品、同断言多次完成（包括76/76诊断）。诊断只改变同文件另一upload用例的路径预期。保留原日志，暂按未持续复现的运行异常，不将其偷偷从记录删掉，也不宣称已知确切调度归因。

## 执行范围与验收边界

批准主agent本轮仅补上述两个明确由Mods重构失效的测试接线（registry、sandbox #36），不修改产品权限/存储/owner/路径安全逻辑。其余本轮交付具体原因与证据，避免拓展成全部旧模块改造。扩展5项需真实资产才能关闭；其余测试假设修正虽低成本，但只有正式改动并跑原测试后才能称修复完成。

另已批准 UAT 启动恢复的“备份后仅补HEAD缺失package字段、保留现值及lock”方案，以及 TTFT 44请求output-only阶段诊断；二者由主agent执行，不属于本报告的产品修改。TTFT诊断始终qualified:false，不能覆盖正式TTFT p95增量53.1ms未达到40ms的结论。
