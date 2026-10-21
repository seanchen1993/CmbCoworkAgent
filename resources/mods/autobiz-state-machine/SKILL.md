---
name: autobiz-mod-state-control
description: 使用已注册的状态 Mod 读取、预检、明确推进 AutoBiz 固定业务图；不替代原产物和 Hooks 校验。
---

本 Skill 指导使用状态 Mod，不自行调用 `hooks/update_checkpoint.py`、`skip_node.py` 或写
`state.json` / `STATE.md`。业务 Skill 负责生成产物；模型的“完成”不是验收凭据。

1. 调用当前插件注册的 `state_read`，传真实 feature；读取 checkpoint 和 stateDigest。
2. 调用 `state_preflight`，传 feature 与明确的下一 checkpoint。Mod 判断固定业务图，
   Python 真正执行原 transition/lifecycle、原产物与 Hook 校验；失败先修复实际产物。
3. 用户明确要求推进后，调用 `state_advance`，传 feature、to、刚读到的
   expectedStateDigest 和独立 requestKey。执行仍需宿主原生命令批准。
4. 只把原脚本返回 `status=committed` 作为此次推进结果，随后重新读取。
   `unknown` 不重放；保留原工作目录和 journal，调用 `state_reconcile`，传 feature 与
   原 requestKey，只读核对物理回执及实际文件。无法确认时仍保持 unknown。

slash 入口：`/autobiz-state-read <feature>`、`/autobiz-state-check <feature> <checkpoint>`、
`/autobiz-state-advance <feature> <checkpoint> <stateDigest> <requestKey>`、
`/autobiz-state-reconcile <feature> <requestKey>`。

本版受控双文件提交依赖 Windows 本地 NTFS 文件锁。其他系统或文件系统不执行推进；
不能把只读检查可用理解为提交也受支持。相同 requestKey 的精确重试只核对原回执，改变
目标或原状态摘要会冲突；同一 Feature 存在未知结果时不能换 key 绕过。

本版仅固定七主阶段及已定义详细设计分支。初始化、新建 feature、回退、任意插步、
旧业务 Skill 的直接推进入口仍属兼容路径，未被此 Mod 全面接管。归档产物物理移动由原
业务动作处理，状态推进不把该移动包装成原子事务。没有统一宿主权威状态或绝对文件隔离。
