# Autobiz Kanban Function Mods 演示

这个目录是把 `seikou00/autobiz_kanban` 转成 CMBDevClaw Function Mods 的示例。打包器固定使用上游 `dev_agents_inject` 分支提交 `8db1ec937d6ed3d271cb9dc540310d6633c91e70`（上游版本 `1.0.79`），因此演示可以复现。

迁移采用混合方式：原项目的 Skills、MCP、Python 检查器和业务目录原样带入；新增的 Mods 只负责读取 `state.json`、显示看板、检查当前阶段产物和按需调用模型做单文件检视。Mods 不修改 checkpoint，不执行 Python 验收器，不把“文件存在”说成“测试通过”。原始 Claude hooks 配置保存在 `hooks/classic-hooks.json`，Function Mods 入口是 `hooks/hooks.json`。

## 生成安装包

在 CMBDevClaw 工程根目录执行：

```powershell
node scripts/package-autobiz-mods.mjs C:/ai/autobiz_kanban output/autobiz-mods-final
node bin/cli.js plugin check output/autobiz-mods-final/AutobizDevOps_Plugin_Kanban_Mods
```

第二条命令应返回 `valid: true`。生成的 ZIP 可以直接在应用的“自定义 → 插件”中导入。

## 实际演示

1. 用 `output/autobiz-mods-final/demo-project` 作为一个项目目录打开新会话。
2. 在“自定义 → 插件”导入 `AutobizDevOps_Plugin_Kanban_Mods.zip`。
3. 在“自定义 → Function Mods”启用该 Mods，确认显示的 digest。
4. 在这个项目会话中输入 `/kanban`，打开看板；选择 `order-export`，点击“检查当前阶段产物”。
5. 也可以直接输入 `/kanban-check order-export` 查看当前 checkpoint 和下一步提示。
6. 输入 `/kanban-review src/export-orders.ts`，让模型只审阅这个文件。该命令会产生模型用量，不会执行测试、写报告或推进状态。
7. 在 `demo-project/.autobizdevops/features/order-export/` 新建非空 `REQUIREMENTS_EVAL.md`，回到看板点击“刷新真实状态”。必需产物计数会从 `4/5` 变为 `5/5`，但 checkpoint 仍是 `requirements_eval_in_progress`；这正是 Mods 和业务验收器的边界。

演示项目故意让 `src/export-orders.ts` 没有排除 cancelled 订单且错误计算税额。模型检视应指出这些问题；它不会声称已经运行测试。

