# DevClaw Feature 对比

| 核心 Feature | DevClaw | Codex | Claude Code | Cursor | Trae | Qoder |
| --- | --- | --- | --- | --- | --- | --- |
| 多 Agent 协作编排 | **强，Coordinator 受控编排** | 中强，Subagents 分工清晰 | **强，Subagents + Agent Teams** | 中，Background Agents 为主 | 中，并行 Agent 执行 | 中强，Experts / Quest |
| Goals 迭代 | **强，`/goal` + 评估续跑** | 中强，durable objective + 长任务接力 | **强，`/goal` + evaluator + `/loop`** | 中，异步任务续跑 | 中，任务流持续推进 | 中强，Quest 持续推进 |
| Agent 自进化 | **强，Trace 反哺 Skill** | 中强，Skills + Evals 完整 | 中，Memory / Skills 沉淀 | 中，Rules / Memories 复用 | 中，Workspace 沉淀 | 中强，Knowledge + Expert 演化 |
| 智能模型路由 | **强，三层路由 + Failover** | 中强，平台调优较强 | 中，任务可配不同 Agent | 中，模型切换灵活 | 中，多模型任务选择 | 中，模型配置为主 |
| 智能上下文节约 | **强，自动压缩 + 按需加载** | 中强，长上下文 + 子任务拆分 | **强，子 Agent 隔离上下文** | 中强，Rules / Memories 复用 | 中，Workspace 汇总 | 中，Quest / Skills 复用 |
| Claw 功能支持 | **强，定时 + 心跳 + 机器人** | 中强，Cloud Task + Remote SSH | 中强，`/loop` + schedule + routines | 中，Background Agents | 中，Async Workspace | 中强，Quest 长任务 |
| 分层记忆管理 | **强，长期记忆 + 每日记忆 + 线程状态** | 中，AGENTS.md + 线程上下文 | **强，CLAUDE.md + Auto Memory** | **强，Rules + Memories** | 中，Workspace Context | 中强，全局/项目 Memory |
| 高性能安全沙箱 | **强，审批 + 沙箱 + 敏感路径拦截** | **强，审批/沙箱/Auto-review** | 中强，权限 + Hooks | 中强，Privacy Mode / 隔离 VM | 中，基础安全 | 中，Hooks / 权限 |
