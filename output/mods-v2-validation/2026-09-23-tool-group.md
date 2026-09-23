# ToolGroup 验证 — 2026-09-23

基线 b69f3b8d；host v44。官方2.1.278对照为 adapted。

## 先失败再实现与检视

真实guest新增6项红测均因MODS_UI_SITE_UNSUPPORTED失败；renderer缺组件、matrix仍planned红测另记录。实现宿主只读calls/isActive与可改布尔isExpanded；nativeExpansion在core派生，最终自定义树不继承，发布伪造无效。增加重复id/过大/数量限制测试。真实guest与相关renderer/pinned-input最初56项通过，后增加3项边界/矩阵并入完整回归。

代码检视复用MessageBubble原有的调用hydration、审批判断和状态推断，不复制一套状态逻辑。组扩展仅改变原详情默认展开，自定义内容作为补充；审批组跳过，原状态/按钮/原始结果保留。只格式化新增嵌套范围。截图已查看，composer与原生卡片均可用。

## 验证结果

- Mods回归17：119文件962测试通过（94.61秒，maxWorkers=4）。
- Node/Web typecheck按package脚本的 --composite false均exit0。首次命令漏该选项产生TS6307，纠正命令；另将renderer未知工具数据作为unknown接收并在共享边界校验，修复真实TS2322。
- ESLint最终0 errors、6 warnings；初次测试render-prop写法触发2项lint错误，改为明确props对象后通过。
- focused Electron tool-sites四项exit0：真实工具组自动展开，原有手动折叠/展开有效；关闭恢复折叠并可查看原结果。wire与SQLite中保留原始结果，无插件展示文字。产物2026-09-23-tool-group-artifacts。
- 综合Electron18：105项exit0，普通out已恢复。包含工具权限、lease、取消/撤权、Client、model stream、compaction、completion freshness及所有新增UI场景。产物2026-09-23-electron-18-artifacts。
- 综合18 read对照各500样本/100预热：baseline p95 3.1385ms、off 3.8344ms（+22.1730%）。没有并行重型验证，仍超过5%预算，性能门禁未通过，不能归因为并发负载。noop1000 p95 9.1568ms、pending0。下一步使用独立五轮矩阵定位；这些不等于最终整应用性能验收。

## 适配边界

按assistant消息分组，不模拟终端跨消息聚合/单行计数折叠。保留原生卡片；isActive对应该消息流式状态。无终端onScreen或非Pane Client。旧全仓26项基线失败仍独立记录，不能宣称npm test全部通过。不是业务验收，Autobiz真实示例与GitHub Actions安装包仍待完成。
