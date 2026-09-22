# Autobiz Kanban Mods 版本演示说明

## 本版本交付物

本工程从 `C:\ai\autobiz_kanban` 拉取了上游 `dev_agents_inject` 分支，固定提交为 `8db1ec937d6ed3d271cb9dc540310d6633c91e70`。源仓库未修改。打包脚本为 [scripts/package-autobiz-mods.mjs](../scripts/package-autobiz-mods.mjs)，工作流导出脚本为 [scripts/export-autobiz-mods.py](../scripts/export-autobiz-mods.py)。

最终包由脚本生成，避免手工复制造成版本漂移：

```powershell
node scripts/package-autobiz-mods.mjs C:/ai/autobiz_kanban output/autobiz-mods-final
node bin/cli.js plugin check output/autobiz-mods-final/AutobizDevOps_Plugin_Kanban_Mods
```

验收标准是 `valid: true`，并能看到 `session.start`、`command.run`、`tool.call`、`ui.render` 注册项。

## 这次实际增加的能力

- `/kanban`：读取当前项目真实的 `.autobizdevops/state.json`，打开 Feature 选择和产物检查面板。
- `/kanban-check [Feature ID]`：输出 Feature 当前阶段和原流程建议，不修改状态。
- `/kanban-review <相对路径>`：提供可选的单文件代码评审；它只是一个检查步骤，不能代表业务验收。
- 完成门禁配置支持关闭、仅报告、阻止完成和自动修复并复检，范围可选文件、diff、Feature 或项目，检查可选代码评审、单测、E2E 和 Autobiz validator，预算按项目保存。
- 启用 Autobiz validator 时，宿主调用固定 commit 的真实 workflow compiler 和 artifact validator，并把结果写入宿主控制的证据链。
- 面板刷新后扫描 Feature 目录及其下一层目录中的非空文件，按上游工作流导出的 artifact 规则列出已找到和缺失证据。
- 所有工作流节点、checkpoint、artifact 和下一步 slash skill 来自上游 Python compiler 的固定提交；Mods 没有重新发明流程表。

## 汇报时可现场展示的结果

演示目录是 `output/autobiz-mods-final/demo-project`，其中有一个 `order-export` Feature，状态为 `requirements_eval_in_progress`。初始目录包含 proposal、design、PLAN 和规格文件，但没有 `REQUIREMENTS_EVAL.md`，所以看板显示必需产物 `4/5`。创建该文件并刷新后显示 `5/5`，而状态仍保持原 checkpoint，证明 Mods 只提供可视化和证据检查，不绕过上游业务门禁。

故意存在缺陷的 `src/export-orders.ts` 可以用于演示 `/kanban-review`：函数没有排除 cancelled 订单，并用加法代替含税计算。模型输出只针对该文件，不声称访问其他文件或执行测试。

## 与原项目的边界

原项目的 Skills、MCP、Python hooks 和检查器仍在包内；原来的 `hooks/hooks.json` 备份为 `hooks/classic-hooks.json`。当前 Function Mods 入口只加载原项目数据并提供交互能力，因此迁移是可回退的增量层。checkpoint 状态推进仍必须通过原项目的 checkpoint API；当前 Mods host 会拒绝未通过 validator 或发生指纹竞争的结果，但 CAS 状态提交和实际单测/E2E runner 仍在继续实现。

上游 Python 测试在 Windows 环境存在基线失败（缺少 `reviewer-agents.md` 以及若干编码/golden 断言）；这些不是本次迁移修改造成的，不能把它们写成 Mods 已通过的验收结果。

