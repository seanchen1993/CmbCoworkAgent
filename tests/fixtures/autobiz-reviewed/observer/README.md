# 并行 Worktree 进度 Mod

技能作者可以通过普通 function Mod 扩展 AutoBiz 的项目体验，不需要为专有进度界面修改平台。

这个扩展使用现有 `on.capability`、原生 Pane/Table/Form、`session.root` 和 `process.run`。
作为独立插件安装，或在“从 Mods 组装”中与 AutoBiz 业务步骤一起选择“并行 Worktree 进度”。
它是观察扩展，不占业务阶段，不影响原 Code/Review/UTest/Merge 门禁。

## 使用

1. 给本地聊天选择 AutoBiz **项目资料工作区**，即含 `.autobizdevops/features` 的目录。
2. 启用本插件或生成插件中的 `autobiz.worktree-progress` 组件，按原设置核对源版本和权限。
3. 在聊天的公开侧栏入口打开“并行 Worktree 进度”。打开只建立面板，不执行进程。
4. 点击“刷新真实 Worktree 进度（保留执行审批）”。原生批准后，运行插件自带只读脚本。
5. 可填写原 Feature/Run 标识筛选。它读取原 durable manifest，不监听或控制 worker。

权限仍由平台检查。读取失败会清除旧快照并显示 `unknown`，不会沿用绿色结果。
没有后台定时执行，没有文件写入、模型调用、测试、分支操作或 checkpoint 更新按钮。

## 真实数据与边界

- 调度记录：`.autobizdevops/features/<feature>/.parallel-runs/<run>/manifest.json`，仅 schemaVersion 2。
- 任务计数：该 Batch 原 `plans/<batch>/plan.json` 的真实任务状态；没有计数则显示 `?`，不推断百分比。
- 检查：原 `stageStates`；可核对阶段证据自身 digest/身份，但不称当前 HEAD 质量已通过。
- Git：只读核对真实注册 worktree、分支、HEAD 和 tracked 修改数量；不执行仓库脚本或 hooks。
- `recent` 只是记录时间较新，不证明 worker 仍存活。五分钟未更新为 `stale`；租约过期不推断进程崩溃。
- 只探测当前工作区内的物理目录。代码仓库在工作区外时显示 `out_of_scope`，不偷偷读取其他目录。
- 默认最多 24 Batch、32 Feature/Run，超限显示诊断，请筛选。多 active run 不默认为其中一个。
- 面板只展示数据。业务质量、测试通过和交付认可仍由原流程与人工判断。

## 可复现的真实 Worktree 演示

需要 Python 3.10+ 与 Git。脚本必须显式指向一个包含原 AutoBiz Python kernel 的插件目录，
可以是新名字组装后的完整 AutoBiz 插件，不需要原插件 UUID，也不依赖源码仓库的 tests。

```powershell
python -B -X utf8 .\demo\prepare.py --plugin-root "<新插件源码或安装目录>" --target "<全新空演示目录>"
```

它只在新目录中初始化本地 Git 仓库，以两份全 `todo` 的合法计划模板作为受控输入，调用
**所选插件**原 `create_run`、`provision_parallel_worktree`、`start_stage` 和 `complete_stage`，
创建两个真实 Git worktree、原持久 run 与 prepare 证据，再留下一个真实 tracked 修改。
它不会手写 run manifest，也不把示例运行宣称为完整商业模型 Code 执行。
Review/UTest/合并和业务验收保持未运行。

将输出 `demo.json` 中的 `workspace` 选作聊天目录，Feature 填 `alpha`，刷新即可看到真实两行。
重复演示必须使用新的空 target；脚本拒绝复用非空目录，不清理或覆盖已有仓库。

要演示“刷新后真实任务状态变化”，在同一个全新演示中运行一次：

```powershell
python -B -X utf8 .\demo\advance.py --demo "<全新演示目录>\demo.json"
```

它仅接受准备脚本的精确路径布局，确认受控文件未被修改后，用原项目初始化器和原租约机制，
调用该插件原 `task_runner.start_task` 启动 `T001`，再留下真实 tracked 修改。刷新表格可看到
`todo:1` 变为 `in_progress:1`。这只是明确标记的受控回放，不调用 finish，不产生通过或完成认可。
一次 target 只允许推进一次；不会把租约 token 输出到面板或日志。

调试原始只读输出：

```powershell
python -B -X utf8 .\mods\business\autobiz.worktree-progress\inspect.py --workspace "<demo.json中的workspace>" --feature alpha
```

原 Code fixed workflow 从其启动参数 `pluginPath` 定位当前插件的脚本，并由 launcher 把当前
`workflows/code-batched-execution.workflow.js` 按内容 SHA 复制到该 Feature 工作区。
本扩展按项目数据发现 run，不依赖原 AutoBiz 插件名或工作流显示名称。
