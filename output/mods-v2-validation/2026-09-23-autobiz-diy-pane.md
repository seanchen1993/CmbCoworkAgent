# Autobiz DIY Pane — 2026-09-23

范围：只修改示例 `examples/autobiz-kanban-mods/hooks/kanban/pane.tsx`，新增 `src/main/mods/v2/autobiz-pane-policy.test.ts` 与独立文档。未修改 manager/session/gate、主 Electron 测试或共享构建输出；未提交。

先红后绿：初版 4 项测试均失败，分别指出检查只能单选、统一配置未保存 target/feature、旧 review-mode 覆盖 canonical 配置、证据只显示 JSON。边界第二轮补充严格数字类型、总预算标签及证据截断提示，3 项失败后修复。证据日志：

- `2026-09-23-autobiz-pane-policy-red.log`
- `2026-09-23-autobiz-pane-boundaries-red.log`
- `2026-09-23-autobiz-pane-policy-green.log`：7/7 passed，4.17 秒（包含旧单文件配置只在主配置缺失时恢复的复核）。
- `2026-09-23-autobiz-pane-eslint.json`：2 文件，0 error / 0 warning。
- Node typecheck 另见 `2026-09-23-autobiz-pane-node-typecheck.log`；当前唯一错误是并行 `manager.ts:14` 导入的 `bindCompletionGateBudget` 尚未由预算模块导出。已通知该模块负责 agent；最终结果由 root 合并检查确认。

测试通过真实编译后的 QuickJS guest、FunctionSession Pane callback/intent 路由与真实 ProjectFunctionFiles，使用实际 SQLite control store。恢复用例确实关闭会话和数据库后重新打开，并证明主配置不会被旧模式字段覆盖。测试没有模型返回 PASS、伪造测试执行或推进业务 checkpoint。

已实现：四种模式/范围、四种检查组合、target/feature 保存、三类预算输入、active 空检查拒绝、严格畸形配置显示、逐步骤原因/文件/下一步说明、24 步/12 文件/文本长度上限、终端控制字符移除。模型预算标签按最终宿主设计写“模型 Token 总预算（输入 + 输出）”；真实计量及修复循环绑定由宿主能力测试证明。

尚未由本子任务执行：完整 Electron 重打包后 UI 验证、实际总预算耗尽、真实 validator 和 checkpoint 业务闭环。root 负责联合集成，不能将本 7 项 Pane 测试描述为这些能力的通过证据。
