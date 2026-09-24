# Function Mods 撤权 E2E 证据更正 — 2026-09-24

在实现 agent.list 时，实际 Electron 的“撤权后命令不应可用”断言失败。核对原 preload/IPC 契约发现 `revokeFunction(threadId, name)` 接收模块名称，新的 helper 和此前 file-metadata/file-write helper 却传入安装来源 ID。原接口对该不存在的授权键不做撤销，但仍 invalidate session，所以旧的“pending 操作被取消”检查不足以证明授权撤销。

本次仅修正两个既有 helper：使用 status 的 mod.name；除原取消/无迟到成功断言，还检查持久授权状态确实变为 needs-approval。未改权限生产实现或放宽断言。agent.list 的同类修正在其独立功能提交中。

实际 Electron 重跑：file-metadata **5 检查通过**，file-write **7 检查通过**，两次顺序运行，日志 `2026-09-24-revoke-file-metadata.log` / `2026-09-24-revoke-file-write.log`，对应 -artifacts 目录。两个 helper TypeScript 和 ESLint 通过。应用是 0ec2e228 后当前 agent.list/v59 工作树普通构建；该构建的其他功能尚在独立验收中，本报告不声明整个未提交功能通过。

此前两份报告的 Electron 撤权表述须按上述范围更正：旧结果是 session invalidation，新重跑才验证实际撤权。既有真正调用 manager.revoke 的 native/guest 测试保持有效。测试修正不改变应用运行路径，因此沿用此前生产性能记录，不用额外性能短测伪装此断言修复的收益。
