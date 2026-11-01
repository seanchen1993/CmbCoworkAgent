# 创造者体验优化与验收

日期：2026-11-01。分支 codex/mods-v2，版本 2.0.0。方案先由 architecture_review、delivery_review 分别评审通过，再实施；实施后另启 ux_recheck_medium、runtime_recheck_medium，以 medium 强度独立回检。

## 用户问题与修改

| 问题 | 根因及本轮处理 |
| --- | --- |
| 128K 连续压缩并报 MODS_MODEL_INPUT_BUDGET | 本机现场配置将 81920 留作输出，输入仅 45080；另有最终 Hook 后预算超限没有安全恢复路径。现在保留用户配置，最终 provider 前只恢复一次，不重放 Hook/工具、不删除系统指令或工具；压缩有余量目标，无进展或固定负载超限会明确停止。设置页显示真实预算关系 |
| 使用指引空泛 | 新增完整创作/试用/保存/再次使用路径、可复制的小需求和每一步完成标准；复制不覆盖草稿、不自动发送，不替用户批准 |
| 工作区难用、不知怎么试用 | 主区按真实版本显示当前状态与下一步；聊天试用授权从高级区提升，项目明确“准备试用环境→配置/确认→开始执行”；原文默认折叠，修改以原对话为主，保留未发送正文 |
| “结果”含义不清 | 改为“输出与面板”，说明命令记录与插件交互面板的区别；面板不作为成功或验收证明 |
| 各分页都有插件链接 | 管理已安装插件只在配置区保留一处明确导航；查看输出不夹带管理入口 |
| 项目依赖被显示为“正在使用” | 按精确安装 ID 的依赖关系显示归属；只陈述当前可用或已选择，不从安装/授权推断执行。保留真实运行记录和原继承/权限规则 |
| Mods 被说成组合插件 | 创作入口改为创建或调整界面、工具、事件规则及流程，组合已有能力是其中一种；移除 AutoBiz 默认示例 |
| 开放能力不明确 | 核实官方 2.1.316 分发包、实际声明与原版探针；补齐安全布局/字体/间距及背景继承，SDK 声明、校验、guest 和 renderer 同步；审计明确 13 个方法/协议缺口，不声称全面兼容 |

## 回检与验证

- A：6 个相关预算/摘要/上下文文件 154 项通过；真实 CustomModelDialog 浏览器检查 128000/81920→45080，保存保持原数值，手动修改才改变显示。
- B：状态投影和真实回对话接线 12 项通过；阶段编辑、完整工作区、聊天开发、项目预览、五步指引五套浏览器通过，包含 375px 窄屏主按钮完整可见。
- E：7 个相关文件 87 项通过；新增真实绘图浏览器在 1100/360px 检查布局、颜色、长文本、按钮与宿主控件；四类容器不是四表面完整导航 E2E。
- 根代理：聊天来源/归属相关 16 项通过；test:mods:experience 七套浏览器整体通过；原项目创建及需求执行两套浏览器回归通过；完整 Node/Web 类型检查通过，修改文件 lint 无错误。测试新增到可达的 npm 脚本。
- 独立 runtime 回检：8 个相关文件 189 项通过；检查 Hook 不重放、固定内容保留、取消、scope 退役、checkpoint/AI-tool 配对、usage 生命周期和 UI 三端一致，结论通过。
- 独立 UX 回检发现并关闭 P2：修改已保存的项目草稿后，旧 installed 记录可能先于候选失效检查，被误显示为“当前版本已保存”。已改为先核对当前候选；历史记录保留但不提供保存、导出或开始使用。补状态 6 项、完整工作区浏览器及交付恢复 19 项检查通过；原 medium 回检 agent 又独立重跑并查看历史态截图，复审通过，无新增 P1/P2。

上述各组有交叉文件，不能相加当作不重复测试总数。模型正文受控的 graph/VM/SQLite 回归、真实 React/CSS 浏览器与真实原版 Claude UI 探针分别记录；未声称重新执行了原用户的真实模型请求或整套业务端到端。未运行全部 npm test，未构建安装包或触发 Actions。

## 可核对的资料

- [实施前方案](mods-creator-experience-plan-2026-11-01.md)
- [简明操作说明](mods-creator-quickstart-2026-11-01.md)
- [2.1.316 能力审计](mods-claude-2.1.316-capability-audit-2026-11-01.md)
- [固定版本与 SRI 证据](mods-claude-2.1.316-capability-evidence-2026-11-01.json)

浏览器截图保留在 output/creator-workspace-browser、output/project-stage-prompts-browser、output/model-input-budget-browser、output/mods-sidebar-clarity、output/application-usage-guide-browser、output/mods-ui-layout-browser。系统 TEMP 的 final-model-budget-final-regression.log、creator-ui-layout-narrow-final2.log、mods-nov1-final-experience-browser.log、mods-nov1-final-typecheck.log、mods-nov1-original-project-regression.log 保留对应结果。

D 盘模板不需要新增业务代码；现有正确 ZIP 继续使用。新体验需要更新平台代码，导入 ZIP 本身不更新应用。

D 盘已同步通用操作说明、能力审计与本验收记录；AutoBiz 作者源及可导入 ZIP 内容没有变化。
