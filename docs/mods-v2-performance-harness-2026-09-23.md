# 可重复的 Function Mods 性能与长稳检查

运行环境使用项目要求的 Node 22，命令从 Mods v2 工作树执行：

```text
npx tsx tests/run-mods-v2-performance.ts --smoke
npx tsx tests/run-mods-v2-performance.ts --phase=matrix
npx tsx tests/run-mods-v2-performance.ts --phase=idle
npx tsx tests/run-mods-v2-performance.ts --phase=soak
```

每次建立独立日期目录和冻结 bundle，不运行 electron-vite，不改共享 node_modules。
run.json 记录 commit、两个bundle哈希、PID、配置；progress.json 和 memory.jsonl
记录工作量与资源，exit.json 记录真实退出码。写该目录 STOP 文件可停止本次运行。

matrix 对 0/1/8 插件各运行 5×1000 个事件，并测关闭分发与直接读取的对照；idle 采集
启用/关闭各 300 秒的进程 CPU；soak 默认 7200 秒、至少10000事件、反复关闭/重建，
检查 frames、calls、pending、replies 与退出子进程。测试专用 wrapper 定时采集 GC 后
内存，不改变生产代码。smoke 会明确标注不满足正式样本要求。

范围是实际 FunctionModsManager、FunctionSession、SQLite 与 utilityProcess QuickJS。
受控文件 core 和 publication passthrough 不是完整 ModsManager/LocalSandbox/保护器，
因此不能替代完整应用的关闭工具成本、8插件/4面板输入、模型流、空闲CPU及Client压力门禁。
分阶段输出也不自动宣称完整门禁通过，必须核对相同代码与各项原始结果。

脚本本身经过16项参数/统计窄测、专用tests TypeScript、ESLint、格式检查；小规模真实
进程烟测 exit 0。报告在 `output/mods-v2-validation/2026-09-23-v2-performance-harness.md`。
正式性能结果、两小时完成情况以各运行目录为准。
