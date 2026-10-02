# F03 · 独立验收记录

2026-10-02 02:11:50 UTC · 主代理。

结论：**F03 授权范围内的接口契约交付 accepted，已本地集成并复核**；不代表真实 Bot 服务或云 Runtime 已完成。

## 代码快照与范围

- 工作树：`/Users/heyirui/.codex/worktrees/devclaw-bot-f03/cmbCowork`；分支 `codex/devclaw-bot-f03`。
- 基线：`77692fdfd2cefd3fe16bf34cc357df4db83abc2c`。
- 已验收代码：`731e0f92bea13bd3d01778f021a7c067fd3a5d29`。
- 最终候选 HEAD：`0f1b6680fb5e26d49a0526652643ef365ba12cf3`；相较已测代码仅 A01 报告不同，Git clean，实施者明确停止写入，无运行句柄。
- 实核 22 个文件：7 个契约/fixtures/README，离线生成器与生成类型，10 个 tests/bot 文件，package/lock 和自己的 A01 报告。package 仅新增 3 个契约脚本与固定已存在 Ajv 版本；lock 仅根 devDependencies 两行。没有修改 F02、原 IM、生产服务/部署或协调文档。

## 主代理检查

已阅读实际改动范围、schema/OpenAPI/状态表、生成器、类型正负消费、fixture runner、参考模型、主要场景及新增 review regressions。DTO 以 JSON Schema 2020-12 为唯一来源，OpenAPI 引用，类型离线生成；状态枚举和普通/对账边以状态表为来源。Bot/Group、工作模式成果交接、Runtime 独立，没有把 Group 固定绑定一条 Thread，也没有把 Bot 当执行进程。

早期审查 R1～R4 已在已验收代码上关闭：

- R1：期限按实际 UTC 纳秒精度比较，等价表示、过期 100ms 和 1ns 边界真实执行；不再靠字符串字典序。
- R2：失败的多对象对账/迁移保持全部状态、证据和 ID 计数不变，没有放宽状态边。
- R3：Delivery 通过 Run/Attempt 回溯 Task/Group/空间与当前资源权限；撤权不能读或重发。
- R4：workspace.write 同时受冻结与当前工作区只读边界约束，create/dispatch/resume 均验证。

额外核对：二进制 PUT 使用实际 Content-Type/严格强 ETag/真实字节摘要与大小限制；OpenAPI 媒体范围、header 投影和 fixtures 一致。成功 DevelopmentHandoff 相同命令返回历史不可变回执，新命令重新门禁，撤权仍拒绝；ApprovalDecision 过期/失效特例保持。未知副作用不自动重放，Run/Attempt/Delivery 完成条件分离。

## 独立复验（不是复制子代理结论）

固定 Node 22：`/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`。下列命令均在上述 F03 工作树执行，代码均为 `731e0f92`（后续报告-only 提交不改变代码）。

| 命令/检查 | 主代理实际结果 | 句柄 |
| --- | --- | --- |
| `node tests/bot/check-contracts.mjs` | exit 0：24/24；包含 schema/ref/fixture、真实 CLI 漂移及未知关键字拒绝、参考模型、生成类型正负消费 | 14659，已关闭 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 | 76742，已关闭 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 | 87248，已关闭 |
| 原 `test:im-v1` 19 个脚本依序以同 Node `--import tsx` 执行 | exit 0，1～19 全通过，末尾 Independent IM 19/19 completed | 50051，已关闭 |
| `git diff --check 77692fdf..HEAD` | exit 0 | 无句柄 |

IM 复验通过正常审批仅开放合成 127.0.0.1 回环监听，不连接真实网关或内网。命令从原 package 脚本提取，要求精确 19 项且每项符合 `npx tsx tests/im-*.spec.ts`，依序用同 Node 执行，任何失败立即非零退出；没有修改或跳过旧测试。原 `86442` 结果仍为未知，不计通过；本次独立 `50051` 是新的完整证据。

## 不在验收范围

没有生产 HTTP/WSS 服务、MySQL/Outbox、S3 不可变、ES、真实 Runtime/节点停止、模型/内网、生产授权引擎或跨进程恢复联调；Java DTO 未生成或编译。不宣称生产 exactly-once。F02 的真实发布连接器仍 CAPABILITY_UNAVAILABLE，OS keychain/Electron E2E 仍未验证；这些限制不因 F03 schema 通过而消失。

本轮仍只有 F02＋F03，不推送、不部署、不连接内网、不购买或重置额度。合入后记录实际 merge 提交和集成检查，再按约定停用本轮自动续跑，等待下一阶段授权。

## 集成与收尾

- merge 提交：`53a86a207b3f60a6b1e94e305d7f9b2eeb186c49`，分支 `codex/devclaw-bot-integration`，目录 `/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`。没有冲突，没有重写候选实现。
- `git diff --exit-code 0f1b6680 HEAD -- . ':(exclude)docs/devclaw-bot-delivery'` exit 0：整个仓库除交付协调文档外与已独立测试候选相同。
- 集成工作树另跑同一契约入口，句柄 `78073` exit 0：24/24、生成漂移检查、正负类型消费再次通过，句柄关闭。
- 02:15:07 UTC 原自动任务 `devclaw-bot` 已按本轮完成边界改为 PAUSED，频率保留 4 小时；工具回执和配置确认。两名实施子代理均交还，没有残留实施或测试句柄，不继续 F04。
- 代码和全部工作树保留，可按记录继续下一阶段；没有 push、部署或真实系统副作用。
