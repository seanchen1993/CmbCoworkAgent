# M01 beta 合入 integration

状态：ready。2026-10-19 用户明确授权把 beta 合入 integration，由 root 设计与把控质量、gpt-6.1-sol 执行。此最新决定覆盖历史仅设计、旧无 Group 页面等限制；本轮交付代码合并与必要兼容修复，不把全部后续产品路线当已完成。

## 固定基准与归属

- integration：d76f30201b8bca9cdf9d26daed1c710ce8c3c1aa，目标分支 codex/devclaw-bot-integration。
- beta：91554cbc7df0b78e37c48d31b72628c16662911a，2026-10-19 已定向 fetch 核对。
- 实施工作树：/Users/heyirui/.codex/worktrees/beta-merge-review/agent-channel-integration-research-7ff0d6。
- 实施分支：codex/merge-beta-into-integration-20261019，从上述 integration 基准创建。
- 实施代理：gpt-6.1-sol / high，唯一产品代码写者。不得派子代理，不写 integration 主工作树或 state.json/HANDOFF.md。
- root 负责方案、任务单、状态与审查；实现代理只写自己的 attempts/M01-sol.md。

## 必须保留的行为

1. beta 客户端 BotsWorkspace、私聊/群聊、工具/真实模型路径、文件交付、浏览器接管、补充消息、后台命令、调度、私有记忆与新校验逻辑均保留。
2. integration Java/MySQL 服务、contracts/bot、V1-V7 迁移、身份/权限/节点/Run/专家记忆不丢失；已有需求/设计模块、凭据隔离和 IM 能力保留。
3. 共享 agent-run-service/runtime/standard-thread-turn 必须语义合并。partnerInputOnly 继续选择独立受限执行体，未注册拒绝，不回落到个人或 beta 全工具执行；beta source=bot 的新增工具、steering、交互等待及后台生命周期仍有效。
4. 各 IPC/preload/App/数据库注册和退出清理均完整；不得只取某一侧文件导致另一侧注册或函数参数丢失。启动器/构建配置/依赖保留双方所需项。
5. beta 私有记忆与 integration 专家正式知识暂保持已有独立范围；本轮不强行自动同步、不自动授予节点权限或创建用户任务。不伪称 beta 的 LocalBotHost 已改为服务端派发。
6. 文档 reviews/beta-integration-functional-design.md 是下一阶段功能闭环依据。此次明确是合并基础；服务端管理 Bot 的适配、成果确认等未实现能力须如实列在交付报告。
7. ES 相关修改或评审必须考虑服务端过滤/聚合、批量与并发、稳定分页及统计口径；无生产实测不能声称耗时改进。无关 ES 查询不要改动。

## 实施步骤

1. 核对工作树/基准/未提交状态后创建指定实施分支，正常 git merge --no-ff --no-commit 固定 beta SHA；保留双亲合并历史，不做整树覆盖或 squash。
2. 报告冲突文件与逐项选择。文字冲突消失后检查自动合并的共享执行/IPC/UI代码，定位语义丢失。
3. 修复合并引入的类型、构建和行为问题。优先保持两边既有实现，必要时增加针对实际冲突的回归验证。禁止删除/跳过失败测试以制造通过；旧测试失效需解释代码事实并保留等价覆盖。
4. 使用受支持 Node 22（已存在 /Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node）。可安装公开开发依赖，避免借用共享 node_modules 做会改包的安装。已有 integration node_modules 可只读复用/链接进行初步检查，若需更改依赖则独立安装。
5. 至少验证 Node/Web 类型、可构建；beta Bot 核心/IPC/相关 UI 测试；integration Partner/专家记忆/执行器与契约；旧桌面/IM 核心回归。Java源未改时证明完全保留并报告可复验入口；root 负责独立关键复验与服务验证。
6. 完成正常合并提交并报告双亲、文件取舍、测试命令/结果/日志、待实现功能和实际遗留限制，进入 review_pending。实现代理不得推送或修改目标 integration 分支。

## 环境与停止边界

不得读出用户密钥、调用真实付费模型、访问内网、部署、重置数据库、清理用户文件或恢复已暂停自动任务。构建不能打开用户现有 profile；测试使用隔离临时目录。不要停止不属于此次任务的 App/服务/容器。禁止 reset --hard/clean 覆盖未提交成果。异常时保存真实差异和 attempt。

root 审查后才能合入 integration；需要返工时沿用同一代理与工作树。推送本轮新结果不在本任务默认动作中。
