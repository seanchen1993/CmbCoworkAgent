# Checkpoint 恢复修复与验证记录

日期：2026-09-09。基线：UAT `357af00fff8e467148cf236f9ace2294d7ddd5ed`。
修复分支：`codex/fix-checkpoint-recovery-integrity`。对应外部 `report.md` 的三项问题。

## 修复结果

| 问题 | 实现与边界 |
| --- | --- |
| 有损展示数据被当作完整模型上下文 | 运行时转换保留图片等结构化内容；消息入库时记录内容和工具参数是否无损。恢复同时检查持久化标记与本次读取截断状态。旧行、已经截断的行和不能证明完整的行拒绝重建；正常完整 checkpoint 继续走原始反序列化路径。 |
| 旧消息时间和耗时未迁移 | 在 checkpoint worker 中按消息 ID、提供方身份或可靠的旧顺序回填。已经完成旧导入的会话也能发现并补迁移。SQLite 归档触发器在 compact values 写入前保存旧时间字段，避免尚未迁移就被删除。 |
| 每次重开重复扫描 generation | 主进程与 worker 共用一次性迁移。持久化标记、字段升级和回填同一事务提交；锁内重新确认标记。普通重开只查标记，不再执行 generation 回填或 `BEGIN IMMEDIATE`。 |

无损标记沿更新、别名合并和复制保守传播，避免二次读取把已经截断的占位文本误认为原始内容。流式文本达到存储上限后只标记一次；后续丢弃片段不增加数据库写入。

时间迁移每批最多 64 条，支持取消后重试；保留既有时间，拒绝无效或倒置时间，校验线程 incarnation，防止删除后同 ID 重建时写入旧时间。旧时间 map 不进入 renderer 或主进程的 JSON 解码路径。

## 代码检视

- 检查消息入库、流式追加、更新、别名合并、分页读取、运行时转换、恢复落盘与重开后的完整性传播。
- 检查完整 checkpoint 对照路径、精确恢复/中断边界、历史尾部与字节预算，以及拒绝恢复时不覆盖缺失快照。
- 检查旧导入首次迁移、已完成导入补迁移、compact 写入先发生、取消重试、源数据竞争、线程重建及已有时间保护。
- 检查主进程与 worker 的并发 schema 升级、事务失败回滚、稳定 generation 身份及普通重开语句预算。
- 使用独立 UAT worktree 复跑全量失败项，失败名称集合与修复分支完全一致。

## 自动化验证

执行使用 Node 22；Electron E2E 使用仓库自带安全 runner、隔离 home、临时 SQLite 和本地模型服务，远程上报及真实业务端点被禁用。

| 验证 | 结果 |
| --- | --- |
| 最终全量 Vitest，`--maxWorkers=2 --no-cache --silent` | 346 个文件：336 通过、10 失败；2524 个用例通过、21 失败、5 跳过。21 个失败均在原始 UAT 独立副本复现，失败集合无新增。 |
| `npm test` 所含全部 71 个独立 `tsx` 套件 | 70 个通过；`im-remote-approval.spec.ts` 的同一断言在原始 UAT 复现。`workflow-worktree.spec.ts` 完整执行，66 项通过。 |
| 新增报告专项回归 | `checkpoint-report-regressions.test.ts` 覆盖恢复、损失标记、图片、流式上限、旧时间和竞争边界；最后另补 prototype key 丢失的针对性回归。 |
| 一次性迁移专项 | `message-snapshot-schema.test.ts` 覆盖一次回填、保留有效 generation、失败回滚及竞争者先完成。 |
| 重开性能、快照 delta、values merge | `checkpointer-reopen-performance.spec.ts`、`checkpointer-message-delta.spec.ts`、`thread-values-merge.spec.ts` 均通过。保留最多 8 条语句的原阈值，并禁止热重开回填与写事务。 |
| 类型检查 | `npm run typecheck` 的 Node 和 Web 两部分通过。 |
| 构建 | 安全 E2E runner 的生产构建通过。 |
| Lint | 本次变更文件零错误；新增代码行无新增 lint 告警。全仓 `npm run lint` 仍报 88 个已有错误，错误所在文件均未被本次修改，另有大量已有格式告警。 |

默认高并发的首次 `npm test` 出现额外超时，因此保持断言和超时阈值不变，以两 worker 完成全量验证；独立脚本逐个执行以覆盖 `npm test` 在 Vitest 失败后未到达的后续套件。

全量 Vitest 的既有失败涉及：Windows 路径、Unix socket、缺失的 Chrome 扩展文件、Windows 文件同步/句柄释放，以及三组已失配的界面源码策略断言。它们仍是仓库未通过的检查，不能把本次结果表述为全仓全绿。

## 真实 Electron E2E

执行 `CMB_SESSION_RECOVERY_E2E_ITERATIONS=3 npm run test:session-recovery:e2e`，三组长会话和五个专项场景全部通过：

1. 每组原始 1002 条 durable 消息，删除祖先快照；首轮在模型执行前修复为 1000 条自包含尾部，受 4 MiB 预算限制。紧接第二轮，逐条核对角色、内容和顺序，检查无重复、无丢失；退出应用后重新读取 checkpoint 校验持久化。
2. 缺失快照的图片会话：实际模型请求中保留图片 data URL，重开后的 checkpoint 仍保留图片。
3. 完整 checkpoint、展示行参数已截断：模型仍收到原始深层工具参数。
4. 已完成旧导入、compact 写入已发生：旧时间成功回填，界面明确显示“耗时 10s”，退出后数据仍正确。
5. 有损工具参数或旧未知来源行：界面显示恢复错误；未调用模型，未写入伪造的修复快照。

三组实测：打开会话 1403–2466 ms，首轮完成 727–1082 ms，紧接第二轮完成 642–766 ms。保留原有耗时断言。打开时间包含首次界面稳定等待；第二轮发送没有额外等待。

UAT 原有 E2E 的输入框可用检查早于运行流挂载，原始基线也会在首次发送阶段超时。测试对首次打开增加 1 秒界面稳定等待；没有修改产品发送逻辑或放宽原来的模型/恢复耗时阈值。

可设置 `CMB_SESSION_RECOVERY_E2E_ARTIFACT_DIR` 保存五个专项场景截图。此次实际查看了 `legacy-timing.png`，确认旧回复显示“耗时 10s”。日志和截图保存在本机临时目录的 `cmb-checkpoint-fix-*` 文件中，不纳入提交。

## 验证边界

这里验证了报告中的三条路径及相关边界，没有访问真实用户会话库，也没有用真实远程模型执行工具。旧版本已经丢失且无法证明完整的数据不会被猜测恢复；已有完整 checkpoint 的正常使用不受这一保守策略限制。
