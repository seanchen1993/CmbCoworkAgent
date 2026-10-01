# F02 主代理独立验收

2026-10-01 14:35 CST · 状态：主代理独立复验通过，F02 受控边界交付 accepted；集成提交 `77692fdfd2cefd3fe16bf34cc357df4db83abc2c`。

## 固定候选快照

- 工作树：`/Users/heyirui/.codex/worktrees/devclaw-bot-f02/cmbCowork`。
- 代码：`dec5cfd4dcbdfe6ea32d12ddfba8639ad63c5adf`；报告 HEAD：`84741848cc921fe74d0389bde5e98c21a8ca4565`。
- 主代理已核对 clean Git、16 个授权文件、范围 diff 与 `git diff f2f348a6..HEAD --check`（退出 0）。子代理已停止写入。
- 主代理读取了实际凭据存储、固定查询网关、发布服务、IPC/可信事件 wiring、preload、前端真实回调与测试；R1～R5 见早期审查记录。未直接改实现代码。

## 独立验证

Node：`/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`，以下均在上述 F02 工作树运行。

| 命令（均由该 Node 执行） | 当前记录 |
| --- | --- |
| `node_modules/vitest/vitest.mjs run src/main/services/requirements/security.test.ts src/main/ipc/requirements.test.ts src/main/main-log-forwarding.test.ts` | session 20243 已结束，退出 0；3 文件、74/74（48+6+20）通过 |
| `node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false` | session 2899 已结束，退出 0 |
| `node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false` | session 83805 已结束，退出 0 |
| `--import tsx` 依次执行下列五项，任一失败立即停止 | session 9241 已结束，退出 0；五项均输出通过 |

五项脚本：`tests/requirement-credentials-renderer.spec.ts`、`tests/requirement-store.spec.ts`、`tests/requirement-mode-skills.spec.ts`、`tests/requirement-history-filter.spec.ts`、`tests/requirement-manifest-loading.spec.ts`。

## 审查结论

- R1：迁移失败拒绝索引写入，测试核对原始字节和零明文临时写入；已关闭。
- R2：同需求的不同 command/Thread 在途或未知结果锁有效，重复命令复用结果；仅在进程内的边界已明示；已关闭。
- R3/R4：读前普通文件检查、打开后 inode/路径校验、有界实际大小读取和最终变更检查，临时 FIFO/增长/覆盖/symlink/100 小文件用例通过；已关闭。
- R5：明确业务拒绝为 `PUBLISH_REJECTED`，不再误报凭据失效；已关闭。
- 核对安装的 electron-vite 默认 main envPrefix 本来就是 MAIN_VITE_/VITE_；显式配置保持原映射，未新增依赖。
- 前端测试执行实际回调/API，但不是完整 Electron 渲染或 OS 凭据交互测试；并未把受控发布边界验收为真实发布能力。
- 复验后 F02 工作树仍 clean，代码提交未变化，四个主代理测试句柄均已关闭。
- 合入后核对与 F02 HEAD 的差异仅为交付文档，source/test 无差异；在集成工作树再次运行相同 3 文件 Vitest，74/74 通过、退出 0。未将子代理自测替代主代理复验。

## 不得隐去的交付边界

- 生产发布连接器缺失，明确返回 `CAPABILITY_UNAVAILABLE`；本轮验证使用 fake publisher/fetch/safeStorage，不是真实 Leanstar/OS keychain 联调或 Electron UI E2E。
- 发布批准、幂等与结果未知锁在进程内；不承诺跨重启 exactly-once，也未提供生产对账解锁入口。启用真实发布前必须补足适配与恢复验收。
- 历史聊天中旧凭据不自动清理；应由用户轮换并按既有保留策略处理。
- 未推送、部署、访问真实模型/内网或读取真实凭据；未扩大 F02/F03 范围。
