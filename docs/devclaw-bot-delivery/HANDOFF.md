# 当前交接点

更新日期：2026-10-01

## 已确认

- 用户希望主代理负责规划、派单及最后检查，代码实施交给 `gpt-6.1-sol` / `xhigh` 子代理。
- 用户要求主代理或子代理遭遇 Token/调用额度限制后，额度恢复时能够继续任务。
- 指定分支已整合，代码与文档分别提交为 `4d778d28`、`9ba9aab0`；验证范围见上级目录整合记录。

## 当前正在做什么

用户于 2026-10-01 回复“开始实施”，确认 F02＋F03 首轮范围。F02 已验收并合入，当前只准备 F03，不进入后续产品路线。恢复仍须核对 `state.json`、live agents 和实际 Git。

F02-A01 由 `/root/f02_credential_isolation`（gpt-6.1-sol / xhigh）完成，当前代理 completed。工作树 `/Users/heyirui/.codex/worktrees/devclaw-bot-f02/cmbCowork` 保留在 HEAD `84741848`，代码提交 `dec5cfd4`。独立验收与集成证据见 `reviews/F02-acceptance.md`，不要重新派发 F02。

F03 任务单及 `tasks/F03-contract-decisions.md` 已 ready。F03 工作树 `/Users/heyirui/.codex/worktrees/devclaw-bot-f03/cmbCowork` 已创建，基线 `77692fdf`，分支 `codex/devclaw-bot-f03`；APFS 克隆已有依赖，不联网安装。12:12 UTC 核对该树 clean、无 attempt 文件、无对应活跃进程、无 F03 代理。首个 attempt 定为 F03-A01，预定代理名 f03_contracts；派发结果须查 state/live agents，不凭此段认定已经创建。

F03 冻结的是接口/fixtures/参考模型，不是服务端或云 Runtime 实现；仍只运行一个代码实施写者，不把结构校验当作生产授权证明。

最新用户要求：改为每 2 小时触发一次，并继续任务。此前的 15 分钟配置已实际删除；本次经明确授权于 06:07 UTC 重新创建当前会话 heartbeat“DevClaw Bot 断点续跑”（ID `devclaw-bot`），回执 ACTIVE，每 2 小时触发。

恢复历史：真实额度中断后接续原 F02 代理，保留 dirty diff 与失败测试历史；R1～R5 已由实施者修复，并经主代理独立验证关闭。06:34 UTC 额度接近限制，F03 仅完成工作树创建，没有发生派单；12:12 UTC 心跳核对 primary 已重置为 0%、secondary 仍为 93%、ordinaryUsageAllowed=true。新 primary 恢复时刻为 2026-10-01 17:12:21 UTC，secondary 为 2026-10-06 00:59:26 UTC。不得切换模型/账号、购买额度或使用重置权益。

F02 新发现：除了两个 Token 入对话入口，还有 `requirements/index.json` 明文保存以及 renderer 直接取 Token 发起 Leanstar 查询。仓库不包含 `requirement-to-prd` 发布 Skill/脚本，已询问用户位置；当前范围先实现受控边界与 Mock 正负向验证，生产发布入口显式不可用，不猜接口。

## 下一步

最新集成基线：`77692fdfd2cefd3fe16bf34cc357df4db83abc2c`；source/test 与已验收 F02 快照一致，集成树额外复跑 74 项 Vitest 通过。F03 创建 operation `2584a4c9-0fbe-4e34-8af7-b4985e7a3dca` 已返回 completed，勿重复创建工作树。

主代理独立复验已完成：Vitest 20243（74/74）、node tsc 2899、web tsc 83805、五项 requirement 脚本循环 9241 均退出 0，句柄已关闭。实际 diff 与 R1～R5 已审查，F02 受控边界交付 accepted；详见 `reviews/F02-acceptance.md`。尚不代表真实发布联调或 OS keychain/Electron UI E2E 已验证。

1. 派发并登记 F03-A01 的 gpt-6.1-sol / xhigh 代理，先建立检查点再写契约，每个可验证步骤小步保存。
2. 对 F03 的 schema、类型生成、API/Runtime fixtures 与可执行状态模型逐项审查，禁止扩张到生产服务/数据库。
3. 保存 F03 检查点并独立验收，不把参考模型、Mock 发布或 schema 通过视为生产系统联调通过。
4. 本轮仍只包含 F02＋F03，不自动进入整条路线。

## 必须保留的限制

- F02 受控边界已验收集成，但生产发布连接器仍未配置；不使用真实 Token 测试，历史泄露凭据需要用户轮换。
- 需求到原型的 selection 消费仍未接通；Java 服务端选择仍待确认。
- 不推送、不部署、不连接内网、不自动购买额度或使用额度重置权益。
- 额度耗尽、用户暂停、任务失败是不同状态。恢复时先确认旧代理/进程是否仍在写入，保留 dirty diff。
- heartbeat 创建/启用状态由 `state.json` 和工具回执决定；不能仅凭说明文档认定自动续跑已经启动。
