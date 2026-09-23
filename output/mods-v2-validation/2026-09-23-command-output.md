# CommandOutput 验证

基线 `3d2e5c59`，2026-09-23，仅 Mods v2 工作树。

- 5个真实guest失败用例先确认当前site不支持，再接入：显示改写、多个owner、command/
  args/isErrored/onScreen不可伪造。与已有site/消息展示测试合计36通过。
- SSR对照保留原生pre/status与布局；超过10000字符绕过新UI，任务记录不增加原始参数。
- Node/Web typecheck与变更源码ESLint通过。代码检视确认只修改结果正文展示，原任务
  状态、取消、失败/未知处理、SQLite持久化和调度均未修改。
- focused Electron command-output1 三项通过：实际输入斜杠命令、真实生产队列/utility
  guest/renderer、重载恢复、关闭后原结果；SQLite公开jobs返回ORIGINAL_OUTPUT和
  succeeded状态，UI显示DISPLAY_OUTPUT，private-argument没有进入新展示或持久化jobs。
- 本轮约8.8秒达到全部场景检查；仅作为有界交互回检，非整应用性能门槛。综合Electron12
  正在以v39快照运行，不能提前记为通过。

日志：`2026-09-23-command-output-*`、`2026-09-23-electron-command-output-1.log`。
截图/证据：`2026-09-23-command-output-artifacts/`。不属于业务验收。
