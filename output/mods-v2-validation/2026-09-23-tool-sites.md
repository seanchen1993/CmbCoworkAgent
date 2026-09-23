# 工具详情展示验证

基线 `a0382f8f`，2026-09-23，仅 Mods v2 工作树。

- 先6个失败guest测试确认原来不支持ToolUse/ToolResult，再实现纯展示接入。追加ToolResult
  的tool/id/error/onScreen固定、SSR真实审批控件保留、非法/循环/超大结果回退。
- sites41 + 原焦点8 + 工具renderer3 + 展示queue3 合计55通过。Node/Web类型检查和ESLint通过。
- focused Electron tool-sites1三项通过：实际普通对话经模型HTTP发出read_file，原沙箱读取
  实际claw-notes文件，展开原工具详情后真实guest改写显示input/output；实际后续模型请求
  与SQLite聊天记录仍含ORIGINAL_TOOL_RESULT且无DISPLAY_TOOL标记；关闭恢复原生结果。
- 真实审批路径SSR证明没有挂载FunctionSite；综合Electron13的89项旧+新回归同时通过，
  包括真实native read审批、取消、lease及焦点。89项不包含专用tool-sites场景，后者单独验证。
- 场景检查约8.1秒；输入/输出JSON、owner数量、IPC并发有上限；不把这一交互耗时视为
  整应用性能资格。正式8插件/4面板、流式和idle基准仍待运行。
- 代码检视：改动仅位于ToolCallRenderer非审批格式化内容区；原状态判定提取为同值变量，
  未改工具执行、权限、取消、原数据、header、原始详情或模型存储。非JSON载荷回退保留原
  容错格式化器，非空PASS显示文本不具备业务验收权。

证据：`2026-09-23-tool-sites-red/green/green-2.log`、`2026-09-23-tool-sites-node/web.log`、
`2026-09-23-site-queue-lint.log`、`2026-09-23-electron-tool-sites-1.log`。
截图和运行记录：`2026-09-23-tool-sites-artifacts/`。模型为本地协议夹具，不是业务验收。
