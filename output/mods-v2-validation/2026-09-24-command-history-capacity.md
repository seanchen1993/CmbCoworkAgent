# 2026-09-24 命令历史绘制容量修复

基线 0664963b；仅 codex/mods-v2 工作树。宿主修订 v60。完整长稳原始失败另见同目录 2026-09-24-desktop-soak-failure.md；本修复未宣称已解决原第6408次确认超时。

## 问题、修复与检视

原命令历史保留并展示最多50条，每条可能有结果和错误两块；CommandOutput却与消息位置共用32槽。超过32条后会持续报 MODS_UI_SITE_LIMIT。现在使用共享 MOD_COMMAND_HISTORY_LIMIT=50，SQL按原上限绑定参数，CommandOutput上限由2×50导出。其他消息位置仍32，旧owner关闭后仍不可再用，满容量仍拒绝新挂载。没有增加历史持久化量、放宽超时、改变原执行或授权链，也没有缓存正向授权。

代码检视覆盖生产ModCommandJobs两个输出路径、SQLite历史裁剪、site按component计数/销毁、旧owner失效、普通位置容量回归。修改局限于明确消费者与容量定义；存量Agent、原生工具和checkpoint执行器未改。

## 失败先行和验证

- 新真实guest/session用例先失败：第33个CommandOutput触发MODS_UI_SITE_LIMIT（site-history-red.log）。修复后sites61+control-store14=75项通过；覆盖100块、101拒绝、释放后替换和旧owner失效。
- 新普通Electron专项先在旧v59包失败：50条历史输出正常绘制等待超时（desktop-history-red.log/artifacts）。修复后的v60专项4项通过（desktop-history-green.log/artifacts）：8真实guest/4Clients、真实历史50条、200次宿主确认、重载恢复50/50/50/50、最终关闭清理。使用原生产IPC/React/SQLite/QuickJS，非测试桥。
- Node/Web typecheck及helper独立TypeScript通过。ESLint零error；全文件既有格式警告保留，新增diff行无warning。按message分组的旧警告比较因Prettier跨行分组变化报差异，已逐项核对非新增行，不声称全仓零warning。
- 默认并行完整Mods50：141文件，1265通过、manager两项5秒超时；隔离原manager套件47通过，未改超时。随后完整Mods51限制4个worker运行：141文件1267项通过。真实utility process41项通过。
- 完整Electron199项检查通过（site-history-full-electron.log/artifacts），exec50520 exit0且普通out恢复。之后仅将新增history专项的报告scope文字明确为非正式长稳；没有改测试断言或生产代码。
- 独占普通桌面性能smoke（exec1392 exit0）：artifact `desktop-performance-2026-09-24T03-33-48-052Z-smoke-d62b16ab`。TTFT p95 159.3→195.6ms（+36.3ms），吞吐比0.994613；约1秒空闲CPU差-3.035371单核百分点。只有每组2个stream样本，qualified=false/passed=false。短样本baseline也高于此前，不能归因为这次容量改动带来的性能提升；正式TTFT +67.7ms失败与长稳6407失败仍保留。
- 最终diff ESLint：8文件0error、修改行0warning（site-history-diff-lint.json）；旧control-store 3条、旧E2E脚本88条格式warning保留。

短回归不替代两小时长稳、正式性能预算或业务验收。本地只编译普通应用；安装包由GitHub Actions完成，尚未触发发布。
