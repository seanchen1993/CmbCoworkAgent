# UAT 1.5.2 工具调用期间「模型返回空响应」排查

## 结论与证据边界

已在用户提供的原始 Windows 1.5.2 安装包中，通过本地模拟接口、真实
Electron/preload/IPC/Agent/read_file/checkpoint 链路复现同一条中文错误。
诊断版也在该安装包中完成相同复验。随后针对用户补充的 DSML 尾标签停止问题，
完成客户端漏检修复及整包验证；当前指定目录安装的是保留诊断日志的 DSML 修复版。

**已确认：**

1. 这条提示对应 LangChain 的 `Received empty response from chat model call.`。
   它表示流式调用未得到一个可合并的 chunk，不能据此断言 HTTP 响应体为零字节。
2. 正确的 SSE 工具调用可正常解析和执行；工具执行后的后续模型请求返回空流，
   或模型以普通 JSON 返回工具调用，都会触发同一条提示。
3. 桌面调用的空响应/断流重试预算为整轮累计两次。工具调用之间成功得到新的模型
   响应后不会归零，换备用模型也不会重置该计数。这会降低长工具链应对偶发故障的能力。
4. 原包与当前本地锁定的主要模型依赖版本一致，未发现这次是 SDK 升级导致的证据。
5. 用户补充的 `</｜DSML｜invoke></｜DSML｜tool_calls>` 停止问题有明确客户端缺陷：
   完成检查没有识别 DSML 文本标签，把非空正文加 `finish_reason=stop` 当成正常完成。
   本次已补充识别并接入现有有界恢复机制，详见下文。

**尚未确认：**实际内网模型故障属于哪一种响应异常，以及近期真实失败率是否上升。
本机已有 `main.log`/轮转日志没有用户所述故障样本，用户尚未提供出错模型、时间或
请求 ID。以下复现均为可控故障注入，不能当成实际网关返回内容的抓包结论。

## 原包复现结果

安装包：`C:\Users\87624\Downloads\CMBDevClaw-win-unpacked-1.5.2`

| 场景 | 模型请求次数 | 实际工具结果数 | 结果 |
| --- | ---: | ---: | --- |
| 标准 SSE 工具调用，再返回最终回答 | 2 | 1 | 正常完成 |
| 工具执行后，后续请求及两次重试仅返回 `[DONE]` | 4 | 1 | 复现相同错误 |
| HTTP 200 返回包含完整工具调用的普通 JSON | 3 | 0 | 复现相同错误，工具调用未被解析 |
| 三次工具调用之间分别发生一次空响应 | 6 | 3 | 前两次恢复，第三次因预算耗尽失败 |

另一个真实 LangGraph/MemorySaver 实验验证：最后一种场景再从 checkpoint 续跑一次
即可完成，已执行的三个工具没有被重放。

48 个 SDK 协议探针覆盖普通、reasoning、interleaved-thinking、DeepSeek 四种适配器：
零字节、仅 DONE、仅心跳、普通 JSON、HTTP 200 JSON 错误、SSE 内的 `message`
而非 `delta`、额外封装层，均可触发相同错误。标准工具 delta（包括省略 role）均可合并。
因此，“只返回工具调用、正文为空”本身不会触发这条 SDK 异常。

## 代码定位及历史

- `src/main/agent/failover.ts:557`：空响应的中文原因和提示是固定文案。
- `src/main/agent/runtime.ts:3892`：只有 HTTP >=400 的响应才走错误体捕获；
  HTTP 200 内的错误 JSON/不兼容格式不会通过该机制进入错误详情。
- `src/main/ipc/agent.ts:4578`：`STREAM_DISCONNECT_MAX_RETRIES = 2`。
- `src/main/ipc/agent.ts:8471,8680`：普通调用的累计预算及 checkpoint 重试；
  resume/interrupt 入口采用同样的计数方式。
- `7fa7a344`（2026-09-03）：新增空响应分类、中文错误卡和两次续跑重试。
  这会改变故障的呈现形式，但不证明故障实际发生率变高。
- `85b59040`（2026-08-03）：整轮断流重试计数已存在；9 月 3 日空响应接入该预算。
- `00f03ff3`（2026-09-07）：完成门禁增加缺陷恢复调用。可能增加一轮任务内的模型
  请求数量，但不是这条 SDK 异常的直接抛出位置。

版本核对：`@langchain/core 1.1.36`、`@langchain/openai 1.3.1`、
`@langchain/langgraph 1.2.5`、`langchain 1.2.37`、`deepagents 1.8.5`、`openai 6.32.0`，
原包、本地安装与 9 月 1 日/当前锁文件一致。

## 已交付的诊断版

源码新增 `model-response-diagnostics.ts` 及测试，并在 `getModelInstance` 的 fetch 配置
接入。正常 EOF 时输出单行 `[Runtime][ModelResponse]`：模型、用途、HTTP 状态、
Content-Type、request ID、是否紧接工具结果、消息数、响应字节数、SSE/JSON 格式，
以及 delta/message/error/DONE 事件数量。

对话正文、工具参数、工具结果和密钥均不写入该诊断记录。行及事件临时缓冲各有 64K 字符上限，
超大事件标记为未检查。响应字节原样透传；日志回调失败不会中断响应；测试覆盖取消和流错误。
本次没有修改重试预算或增加 JSON 自动转换。

诊断包中实测日志摘要：

```text
工具后空流：afterTool=true, bytes=14, format=sse, deltaEvents=0, doneEvents=1
普通 JSON 工具调用：bytes=409, format=json, deltaEvents=0, doneEvents=0
正常工具后回答：afterTool=true, bytes=294, format=sse, deltaEvents=1, doneEvents=1
```

已替换文件：

`C:\Users\87624\Downloads\CMBDevClaw-win-unpacked-1.5.2\resources\app.asar`

原始备份：

`C:\Users\87624\Downloads\CMBDevClaw-win-unpacked-1.5.2\resources\app.asar.before-empty-response-diagnostics-20260915`

SHA-256：

- 原包：`67b822490e9ec262b337b8933230a3de1335e516015e9a153db865902db72158`
- 首版诊断包（已被下文修复版替换）：`be4323b8423e7b3df09758af5d5a4513816fe933c9729b13486c12ccd633c68e`

构建自当前 UAT `575d65dc` 加诊断代码。原包的 51 项编译期配置在内存中恢复到构建环境，
构建后逐项比对完全一致，避免缺失本地 `.env` 改变接口地址等行为。归档仅替换主进程入口；
原有 renderer、其他文件内容和 unpacked 标记保持原样。
已校验归档元数据、替换文件内容及实际应用启动/工具调用。测试使用隔离数据目录，
没有复制用户凭据或运行用户已有任务。测试进程已关闭。

恢复原版时，退出该应用后，将上述备份复制覆盖同目录的 `app.asar`。

## 验证状态

- 相关 Vitest：7 个测试文件，44 项通过（本机系统 Node 24.14.0；整包链路另行验证）。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- 原包和最终诊断包各完成四组上述 Electron 集成场景；最终包实测
  Electron 39.8.0 / Node 22.22.0，并断言 15 条结构化诊断日志完整落盘。
- 新增两个文件的 ESLint：通过；`git diff --check`：通过。
- 全量 `npm test` 未通过，包含未修改模块的失败（例如 IDE 平台测试、浏览器扩展测试、
  managed-run journal、性能测试）。不能声称全仓回归通过。
- 全仓 lint 未通过：96 errors，另有大量既有 CRLF/格式警告。
  修改的 runtime 文件中的 `availableSubagents.map((subagent: any) => ...)` lint 错误
  经 `git show HEAD` 确认原来即存在；未顺带修改。

详细模拟脚本、原始记录及截图：
`output/uat-empty-response-investigation-20260915/`。
全量检查日志保存在 `tmp/uat-diagnostics-*.log`。

## 下一步收集真实故障及修复顺序

1. 用指定目录的诊断版重现原先任务，记录模型名和发生时间；读取
   `C:\Users\87624\.cmbcoworkagent\logs\main.log` 中对应的 `[Runtime][ModelResponse]`
   及相邻 `[Agent][Retry]`/错误堆栈。若设置过 `CMB_COWORK_AGENT_HOME`，读取该目录下的日志。
2. 若是 `format=json`，核对网关是否忽略 `stream:true` 或用 200 包装错误。
   只有确认合法的完整 completion 后才能做 JSON 兼容转换，不能把任意 JSON 当成功回答。
3. 若是 `bytes=0` 或仅 DONE，使用 request ID 关联网关日志，检查工具消息之后的路由、
   上游异常、上下文/参数限制；本次没有证据将其直接归因于某个具体模型参数。
4. 重试策略建议按一个模型步骤的连续失败计数，在新的模型消息成功提交后恢复预算，
   同时保留整轮安全上限；不能在 HTTP 200 或首个 token 到达时无条件清零。
5. 校正错误卡描述及“已尝试备用模型”的提示。原包固定模型场景没有发生模型切换，
   文案仍声称尝试过备用模型，应按实际尝试记录显示。

## 补充：DSML 尾标签后直接停止，已修复并替换

用户补充的回复在正常中文后出现 `</｜DSML｜parameter>`、`</｜DSML｜invoke>`、
`</｜DSML｜tool_calls>`。这些标签属于工具调用序列化格式，结构可参见
[DeepSeek 官方编码说明](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731/blob/main/encoding/README.md)。

确认的客户端原因：`containsTextualToolCall` 原先仅识别部分其他工具标记，并要求位于行首。
DSML（尤其是只有结束标签、直接接在中文后的情况）漏检；没有结构化 `tool_calls` 的消息
因此结束 Agent 图，且完成检查错误地接受该正文。本地 SSE 注入同形文本及 `stop` 结束信号，
在修复前的实际安装包中稳定复现一次请求后结束、没有执行工具。

源码修复位于 `src/main/agent/turn-completion-integrity.ts`：

- 识别 DSML 行首工具标签及位于正文末尾的 invoke/tool_calls 成对结束标签。
- 兼容全角/半角竖线、标签空白和 Markdown 转义。
- 排除代码块、行内代码及引用行，单个行内标签说明不触发恢复。
- 复用既有 `textual_tool_call` 恢复提示，要求模型重新发送结构化调用，最多续跑两次。
  仍失败则明确提示本回合未完成；不会把残缺文本直接解析成文件编辑操作。

整包使用隔离配置和本地模拟接口，实测 Electron 39.8.0 / Node 22.22.0：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 先泄漏尾标签，再返回合法 read_file 和最终回答 | 1 次模型请求、0 次工具调用后停止 | 3 次模型请求、1 个工具调用 ID，正常完成 |
| 持续返回 DSML 尾标签 | 1 次模型请求后被当作完成 | 3 次模型请求、2 次恢复提示，最终明确未完成 |
| 正常回答中的行内代码标签示例 | 1 次模型请求，正常完成 | 1 次模型请求，无恢复提示 |

恢复场景的消息存储出现同一工具调用 ID 的重复结果行；测试按调用 ID 去重，
并额外断言第三次模型请求中恰有一个对应工具结果，运行日志也只有一次 read_file 调用计数。
本次未修改消息存储去重逻辑。

验证结果：

- 先添加回归用例时 8 项失败；修复后完成检查及真实 Agent 图测试共 57 项通过。
- 全量 Vitest 中上述 57 项及响应诊断 6 项均通过。
- `npm run typecheck`、相关 5 个文件 ESLint、`git diff --check` 通过。
- 使用原包 51 项编译期配置构建成功，逐项比对一致；归档仅替换主进程入口。
- 修复包的 3 组 DSML 场景及原有 4 组接口场景通过，15 条响应诊断日志校验通过。
- 本轮 `npm test` 在 Vitest 阶段失败：384 个文件通过、11 个失败；2991 项通过、
  30 项失败、5 项跳过。失败涉及未修改的浏览器扩展、IM、IDE、看板等模块，
  后续串联的 standalone suites 未执行，不能视为全仓回归通过。

当前已安装修复版 SHA-256：
`668da7cde9801c208dd92121d5b6d4adbb54d75559f59b7788c47a4b4648fe18`。
原始备份位置不变，备份哈希已再次校验。

记录位置：`output/uat-empty-response-investigation-20260915/uat-package-inspect/`
中的 `dsml-before.log`、`dsml-after-verified.log`、`dsml-network-regression.log`；
检查日志为 `tmp/uat-dsml-*.log`。

证据边界：此修复解决客户端漏检和无提示停止。上游为何将 DSML 原始标记放入正文，
仍需要真实请求/网关日志判断；也不能据此断言此前所有 SDK 空响应错误都由 DSML 引起。

## 推送前代码复查

复查补充修复两项边界问题：

1. 有序列表引用（`1. >`、`1) >`）中的 DSML 尾标签此前会命中正文末尾规则，
   引起正常回答被续跑。现在同时排除有序/无序列表中的引用行。
2. 诊断器此前仅按 LF 拆分 SSE；当响应使用裸 CR 换行时，正常事件会被记成未识别数据。
   现在兼容 CR、LF、CRLF，并处理 CRLF 被网络分块拆开的情况，与本地 SDK 的分行能力一致。

新增用例先复现 3 项失败；修复后相关 3 个测试文件共 68 项通过。
类型检查和相关 5 个文件的 ESLint 通过。按原包 51 项配置重建后，仅替换主进程入口，
更新了指定测试目录的 asar。最终整包验证日志为 `review-dsml.log`、`review-network.log`。

推送前再次运行 `npm test`：383 个测试文件通过、12 个失败；2995 项通过、31 项失败、
5 项跳过。与上一轮对比，原有 30 项失败一致，新增 1 项是 Windows 后台 Job 测试清理
临时 exe 时发生 `EBUSY` 文件锁错误。该文件单独复验 9 项全部通过。本次相关 68 项
在全量运行中均通过；全仓仍不能标记为全绿，Vitest 后续的串联测试仍未执行。
日志保存于 `tmp/uat-review-full-test.log`、`tmp/uat-review-windows-job-recheck.log`。

提交仅包含本次源码、回归测试和本报告；诊断运行日志、带编译期配置的提取产物、
打包文件及其他任务的未跟踪文件均不纳入提交。
