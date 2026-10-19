# M03：文本成果确认与退回修改验收

状态：accepted，2026-10-19。root负责设计、逐段源码审查和独立复验；唯一实施者 `/root/service_conversation_sol`，`gpt-6.1-sol/xhigh`，已提交停写。设计基准 `05a1dcf8`，最终候选 `ae7029571ee7741cc52fbcf9de49a93113f9d93e`，正常合并 `5beb5c604779593a6d818a2ac30c0cd2316c3d49` 至 `codex/devclaw-bot-integration`。目标产品目录与候选一致，M01采用的beta基准 `91554cbc` 和M02候选 `96e6e142` 均保留祖先关系；不表示本轮再次合并了之后新增的beta提交。未推送或部署。

## 已交付闭环

当前单服务专家文本成果 v1 → 提出修改意见 → 同Task修订生成v2 → 确认v2 → Task真正完成。每版全文、来源Run/attempt、摘要、修改意见及决定人/时间可回看；旧版不可覆盖或误确认。确认无需节点在线或模型调用，已完成任务禁止继续发消息/执行，界面保留切任务和新任务入口。

服务从自己的成功Result复制成果，新增V8五张内部表及Run修订标记；成果发布/Task状态/事件、退回决定/一次反馈消息、确认/Task完成分别原子持久。固定业务确认人与Bot、当前成员和Group权限、Task及审阅版本CAS同时校验。历史命令仍返回原回执，但先核对当前访问权限；普通补充使旧成果失去确认资格。

主进程SQLite先保存原命令再发送HTTP，发布、决定、修订入队可在失回包或退出后继续原步骤。明确失败/开始前受阻允许重新选择模型后显式继续，不重复反馈；unknown保持待核对，不重新开模型。服务冻结旧版全文/digest和意见，严格进入受限DeepAgent实际输入，缺失或损坏时拒绝降级。沿用60K输入预算及零工具边界。旧M02成功结果不自动回填，可显式提交有效结果为成果；读历史不产生写入。

## 审查发现与修正

- 服务初稿版本列表读取全文、已有head可能重置确认人/Bot、受管Task在途消息可修改版本，均修正。正文和摘要独立存储；修订Run有持久marker，缺行不能走旧输入路径；持久JSON与SQL索引归属、command receipt关联均核对。
- 主进程修正8条outbox首批饥饿、重试与supersede之间的恢复窗口、已接纳修订但action保存失败的恢复、旧blocked请求永久阻止确认，以及模型漂移原因被starting/running轮询清除的问题。
- root实际复现“send等待模型时，approve已经完成仍接纳send”及两个不同operationId同时继续修改的竞争。最终同步接纳门禁拒绝迟到补充，只接纳一个重试；原探针复跑通过，反馈仍一条。
- UI修正首挂载重复读取、每轮重复取正文、历史增长后的分页、正文读取失败缓存空白、新版正文未到就可确认、已完成任务误禁侧栏等。当前版本自动跟随新成果，用户明确查看历史时保留选择，迟到响应隔离。
- 实际partner-dev启动迁移guard同步支持V8；Task读取接受受控active/awaiting_business/completed形状，历史create回执不依赖当前可变状态；真实Task事件版本连续，未执行阶段在完成时取消。

## 验证证据

以下均为真实执行结果；临时日志位于本机 `/tmp`，测试源码和实施记录已提交，可重跑。root独立HTTP完成时的48个产品/测试文件SHA快照与冻结候选完全一致。

| 所有者/检查 | 结果 |
| --- | --- |
| root 最终核心 | 92/92，Partner client/config/worker/controller、service conversation/runtime、delivery、executor；`/tmp/m03-root-core-final.log`。 |
| root IPC与契约 | IPC18/18，`/tmp/m03-root-ipc.log`；完整契约25/25，`/tmp/m03-root-contracts.log`。 |
| root 原生SQLite | 105条意图重开后稳定游标全部可读、批次≤8、查询走pending索引、原command不变、scope隔离、旧摘要不倒退，14条畸形输入拒绝；`/tmp/m03-root-store-probe.log`。 |
| root SQLite写失败 | 远端内存fixture提交后以真实SQLite `query_only` 拒绝本地receipt写入，物理重开原命令恢复，无重复版本/决定/Run；`/tmp/m03-root-sqlite-fault.log`。这项不是HTTP测试。 |
| root 并发接纳 | 首次独立探针真实发现迟到send问题，修复后原样通过；完成后迟到send拒绝、同时retry单接纳；`/tmp/m03-root-admission-race-fixed.log`，原失败日志保留。 |
| root 实际Electron UI | v1/退回/失败后继续/v2/确认、42版历史、迟到正文隔离、完成后侧栏、重开不发送、终态停止正文轮询；`/tmp/m03-root-ui.log`。M02 UI回归含41条历史、交办、同Task补充和精确停止；`/tmp/m03-root-m02-ui.log`。 |
| root 真实完整旅程 | `Node22 --import tsx tests/bot/text-delivery-http-journey.ts`退出0，`/tmp/m03-root-http.log`。真实Java/MySQL、物理SQLite重开、单worker、现有DeepAgent fake；发布/退回提交后丢回包、模型漂移拒绝后显式继续、v2输入含v1全文/意见、无节点/模型确认、旧开发入口仍fake。模型3次（业务2+legacy1），工具0。 |
| root 同旅程数据库专项 | V7升级旧事实/Result保留且无自动发布；17项拒绝、回滚/提交后失回包、缺失/篡改输入、历史create回执、事件1..5、并发单赢家、撤权/错关联receipt、41版大正文分页；随后串行新V8库/31表/noFK通过。 |
| root 合入目标复验 | 主进程与Web `tsc --noEmit ... --composite false`均退出0；禁用66个Vite配置键、隔离环境完整main/preload/renderer构建退出0，未启动App；`/tmp/m03-root-target-main.log`、`/tmp/m03-root-target-web.log`、`/tmp/m03-root-target-build.log`。 |
| 实施者补充 | 新编Java71 JUnit/1884 schema parity零差异/Jar audit，`/tmp/m03-java-final-build.log`；核心103及另补预算runtime27/27；IPC18、服务/迁移guard19、隐私提示20、桌面/IM回归、两端和测试类型、格式、完整构建与最终Electron通过。详见 `../attempts/M03-sol-xhigh.md`。 |

## 性能与已知局限

版本列表SQL按scope/task/number稳定游标只读取summary_bytes，41取40；正文按需读。隔离MySQL的41个16K中文正文版本，首40条摘要响应25014 bytes，低于客户端524288上限。摘要批次≤40，SQLite pending批次≤8且稳定轮转，原inspect/worker并发边界保持；UI终态不重复获取正文。这是查询结构和隔离测试证据，未测生产实际耗时；没有ES查询改动。

保留未归因失败：`/tmp/m03-http-final.log`在主业务闭环完成后，附加41版历史探针出现一次 `DEPENDENCY_UNAVAILABLE`，当时没有轮次/SQL上下文且测试资源已回收。新增有限轮次/操作及安全代码位置诊断后，实施者两次完整旅程及root一次独立旅程均通过；窄审未发现共享节点后台tick或该阶段锁顺序错误，未放宽2s SQL/锁限制。不能据后续成功宣称已经修复这次异常的根因；若再发生，按新增诊断定位。

其他已解决测试失败保留在attempt：MODEL_CHANGED通知丢失为产品竞态且已修；Jackson即时LongNode与落盘BigIntegerNode的equals差异改为wire JSON字节比较，没有改业务回执。测试误用Node执行Vitest、tsc遗漏composite参数等均纠正并通过。

本轮仅文本成果，未扩文件上传/S3、通用多级审批、多专家协同、多设备历史、自动记忆或网关合并。真实模型配置路径保留，但本轮全部推理fake注入，未实测生产provider质量、速度或生产环境。

## 环境和交接

root独立测试项目 `c9370dbb52ca6dc0`、`31928b11d9c131f6` 精确回收；实施者各项目同样已回收。`/tmp/m03-root-resource-audit.log`确认专用daemon不变，测试容器/卷/网络/runtime目录均0，M03 HTTP/UI/Java进程0。原B00 MySQL `693a1c3` 已按本轮启动凭证恢复exited且保留卷；用户Partner MySQL `bdf4f0d`保持exited，原ES/S3同ID健康。恢复日志 `/tmp/m03-root-db-restore.log`。

自动任务TOML已只读核对仍为PAUSED，未恢复。无用户App profile/密钥/内网/付费模型/推送部署操作。M03没有剩余实施项；后续范围等待用户安排，继续采用root设计与验收、6.1-sol实施（复杂xhigh、简单high）。
