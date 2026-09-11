# 流式显示修复与 UAT 合并检视（2026-09-11）

## 合并状态与问题判断

修复分支为 `codex/fix-stream-review-findings`。先保存独立检视修复，再合入
`origin/UAT` 的 `892af3ca`（版本 1.5.2），合并提交为 `283d8448`。
工作目录为独立 worktree，原工作区的 updater 修改未纳入本次提交。

UAT 的 `a2f19c0f` 修复了主进程后台汇总发往无人订阅频道的问题：
`agent:stream:<threadId>:coordinator-internal` 等非请求频道现在进入常驻 scheduler
接收链路。它与“工具调用后 trace 继续、页面不继续显示”的反馈直接相关。
`bdfcf468` 还包含后台 IM/Goal 的常驻投递及当前轮 values 合并；本次保留这些行为。

不能仅凭反馈认定两种消失现象只有一个原因。本地验证发现了多个独立的消息投影与落库
问题，但没有使用受影响用户的原始会话事件完整复现其“完成时闪一下”的全部过程。
后台 trace、日志或下一轮模型上下文仍有内容，只能证明执行层有数据，不能证明 UI
投影、持久正文及后台频道都正确。

最初的 `hasLiveStreamMessageId` 读取 `undefined.id` 有明确的 renderer 异常链路。
这与 OOM 是不同的故障机制；现有证据不能把用户所有白屏都归为内存不足。
UAT 的错误边界及首次 renderer 进程崩溃恢复是恢复措施，不能代替消息一致性修复。

## 已确认并修复的路径

1. **前台流与工具边界。** 使用应用自己的消息累积与身份规范化，处理短 values 后的
   稀疏位置；同一 provider ID 的工具结果与助手正文保持不同角色和周期，避免替换错行。
   工具参数与工具卡错误边界局部处理异常，窗口关闭对话框独立于应用内容错误边界。
2. **正文和思考更新语义。** 明确区分 delta、完整 snapshot 和字段缺失。重复增量原样
   追加；更短、更正或空 snapshot 替换对应字段；缺失字段保留已有值。values 改变基准后，
   下一个完整 snapshot 重新建立基准，不能沿用旧长度差分。
3. **后台主调度链路。** UAT 路由修复后，snapshot 必须同时更新页面与 scheduler 的续写
   累积值。否则 `draft → fixed(snapshot) → tail` 会回到 `draft tail`。现在保留为
   `fixed tail`。明确 reasoning delta 贯穿 converter 与实际消费者，`r → delta r`
   保留为 `rr`，不再被历史的前缀去重吞掉。
4. **子代理显示及存储。** converter 传递 snapshot 模式；子代理投影、增量持久化、正文
   引用、失败重试及 ACK 均保留同一语义。显式清除只影响指定字段，另一字段与其 journal
   保留。修复 reasoning-only bootstrap 误把缺失正文当空字符串写入的问题。
5. **主进程持久正文。** 当前物理 run 校验之后再持久化 native values。values-only 的
   多工具周期按顺序保存，provider 身份与已存在的 DB 行一致；只查询变化的身份，不重新
   读取整段历史正文。显式 native 正文/思考不能被旧 UI 回写覆盖。
6. **Stop/Goal/harness。** 抽取实际运行使用的正文汇总及 Stop 上下文，统一 snapshot、
   空清除、多周期和重试语义。Goal 的明确空结果与“尚未提供结果”分别处理，避免回退到
   已经被撤销的旧回答。没有修改模型、提示词、工具定义或评估标准。
7. **窗口关闭。** renderer 失效或无法响应时由主进程提供原生关闭选择；保留 UAT 每个
   窗口只自动恢复一次的策略，避免重复崩溃时循环加载。

## 独立检视

三个子代理均按用户要求使用中等思考强度，分别检查 renderer、序列化/持久化和
Stop/Goal/harness。最后的交叉检视独立执行真实 serializer → managed delivery →
消费 helper 的事件序列，覆盖更正、重复推理、清空和缺失字段，相关 13 项测试通过。
已确认的本次问题均完成修复；这不等于证明不存在所有未知故障。

`modelRetry` 在纯 snapshot-only 后台流的清理属于 UAT 已有相邻行为；未取得实际会话中
持续残留的证据，也未发现本次引入的回归，未扩大修复范围。

## 验证结果

环境：Windows，Node 22.23.2，Electron 39.8.10。真实窗口测试使用临时用户目录；模型
事件由 fixture 控制，HTTP 请求被阻止。未覆盖真实用户安装或向 IM 用户发送消息。

| 验证 | 结果 |
| --- | --- |
| 最终全量 Vitest，2 workers | 369 文件；2758 通过、21 失败、5 跳过 |
| 最新 UAT 基线复验上述失败文件 | 相同 21 个失败名称，未出现新增失败 |
| 展开 npm test 的独立 suite，加流/性能专项 | 91 组，87 通过，4 组失败或超时 |
| 最新 UAT 复验上述 4 组 | 相同失败点或 180 秒超时 |
| Node / Web TypeScript | 通过 |
| 完整 build | 通过 |
| 浏览器真实 React fixture | 5 项通过，包括工具错误隔离及应用错误边界后的关闭提示 |
| 源码构建的真实 Electron 端到端 | 9 项通过，捕获的页面异常为空 |
| 隔离 ASAR 端到端 | 同样 9 项通过，捕获的页面异常为空 |

四组独立 suite 未通过的原因分别为：`workflow-worktree` 180 秒超时；
`local-sandbox-worktree-isolation` 在 PowerShell 执行 `pwd -W`；
`im-remote-approval` 的 Windows 路径断言；`sandbox-elevated.unit` 的两个 workflow
通知源码断言。均在 `892af3ca` 重现，不能报告全仓测试全绿。

源码全量 ESLint（排除临时 output/tmp）有 93 个错误，分布于 44 个文件。本次改动文件
中只有 `stream-converter.ts` 的既有 `_internalNotification` 未使用错误，已在 UAT
同文件复验；新增 helper 和测试没有 lint 错误。未为消除基线告警改动其他模块。

端到端覆盖 1000 分片、40 次工具输出、200 次历史切换往返、相同 provider ID 跨角色、
完成后的正文/思考落库与再次进入历史、UAT 后台汇总的更正与重复增量，以及白页关闭、
首次崩溃恢复和第二次崩溃后的原生关闭。

首次新增恢复测试曾超时。隔离实验定位为 Playwright `context.route` 对崩溃后本地
文件重载的干扰：移除它后同步和延迟 reload 均恢复。仅调整测试，在该阶段用 Electron
`webRequest` 保持 HTTP 隔离，没有据此修改产品 reload 策略。
Playwright 的旧 Page 对象在恢复后还会保持 crashed 标记，因此恢复后的读取和点击使用
存活的 `webContents` 操作真实 DOM；没有额外手动刷新来掩盖恢复失败。

隔离 ASAR 使用原打包运行时与依赖、当前构建的 main/preload/renderer bundle；关键
bundle 已逐字节比对。它是打包路径回归副本，不是正式发行安装包。ASAR 大小为
359962703 字节，SHA-256 为
`ed6e2f3e593eea20b7b7601551f0315adc22a98c5b921d4bdc91ee0a8bc9fdd8`。
原下载目录中的应用未被覆盖。

## 性能与兼容性边界

同机与最新 UAT 交替执行三轮微基准：

- 10000 次重复 delta：修复版约 53–63 ms，正确保留 20000 字符；UAT 基线约
  58–67 ms，但错误地只保留 2 字符。
- 1000 个累计 snapshot，每次增长 120 字符，同时包含正文、思考和工具参数：修复版
  约 113–779 ms，UAT 约 16–21 ms。准确前缀比较引入 O(N) 成本，不能宣称全面提速；
  该基准平均每帧约 0.11–0.78 ms。IPC 仍只发送增长部分或必须更正的字段。
- 10000 条历史与 2000 条当前轮前缀，1000 次尾部 values 更新：修复版约 41–50 ms，
  UAT 约 38–44 ms；两者只序列化 1000 个变化的正文，没有重新序列化历史正文。

新增 values 身份选择仍需遍历当前轮身份，并非 O(1)。已用带有抛错正文 getter 的长前缀
验证不读取未变化正文，查询选择器限定为变化的身份；真实 SQL 延迟、极长会话峰值和
长时间多任务内存曲线仍需要实机观测，微基准不能替代这些测量。

DB 增加内部 `stream_authority` 字段，默认值兼容已有行，迁移及关闭重开已用实际临时
SQLite 验证；字段不进入 UI 消息 DTO。尚未拿受影响用户的真实旧数据库执行升级回归。
子代理显式 snapshot 清除 journal 与正文更新在事务内完成，并覆盖失败回滚。

harness 已验证实际 Stop/Goal 汇总、工具周期及受控 SSE 流的行为一致性；没有进行真实
模型质量评测，不能据此承诺模型效果完全不变。未进行真实 IM 会话或持续数小时的高内存
压力测试，也不能据当前结果宣称修复所有 OOM/GPU/操作系统层面的白屏。

## 可复查产物

工作树 `output/review-final/` 保存：

- `uat-final.json`、`baseline-uat.json`：全量结果及同基线失败对照。
- `uat-standalone/standalone-summary.json`、`baseline-summary.json`：独立 suite 结果。
- `uat-build.log`、`lint-summary.json`、`baseline-uat-stream-lint.log`。
- `benchmark-uat.mts`、`benchmark-uat.json`：可重复的性能对照。
- Electron、浏览器、打包执行日志及 ASAR 摘要；窗口截图和结果位于
  `output/stream-white-screen/`。

日志、临时用户数据、打包副本与生成的 bundle 不纳入提交。
