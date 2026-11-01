# 第一阶段：现有页面与能力贯通验收

日期：2026-11-01。分支 codex/mods-v2，应用版本 2.0.0。实施前 architecture_review、delivery_review 分别正式评审通过 [具体方案](mods-continuity-phase1-plan-2026-11-01.md)，通过后才修改产品代码。实施后两个全新 medium agent 独立回检，均通过，无剩余阻断性 P1/P2。

## 完成范围

| 路径 | 本轮接通的断点 |
| --- | --- |
| 插件启用→设置/返回聊天 | 纯传统 Hook、MCP 配置插件也能识别使用入口。新增摘要只投影原声明数量和服务名，不暴露命令、地址或凭证，不冒称已连接或已执行。包含 Function Mod 的来源仍必须满足原配置、授权和选择条件 |
| 插件→原项目入口 | 根据实际 Host/传统项目类型统一遵守原 projectMode 开关；原生子入口透传 busy/disabled。没有替换项目创建、配置、需求管理或执行页面 |
| 聊天复用→修改→新试用批准 | 新的精确待批准版本进入试用页，批准卡可见；同身份刷新不抢页签。普通聊天功能的试用/保存导航保留，原批准接口和参数不变 |
| 开发文件夹→依赖→候选→试用/保存 | 活跃源码准备与普通聊天试用可共存，真实依赖待办不再消失。unknown 优先核对原结果，不能自动重装。ready 不再强制跳保存；只有真实当前候选才提供前往已有试用/保存区的导航，导航本身不运行或授权 |
| 已生效功能→插件界面 | 使用卡和实际 active 试用卡可发现现有 surface。精确匹配宿主 provider、Function Mod compiled digest 和完整 entry key；试用点击前再读当前组件/修订。打开后能操作、关闭并返回原聊天，未发送正文保留 |
| 界面准备、错误和失效 | 冷目录的“查找”与实际打开明确区分；没有入口或声明错误时显示真实反馈和配置/聊天去向。打开意图只领取一次，不因其他来源 canPrepare 额外准备。账号、目录、聊天 incarnation 及来源 generation 变化后拒绝旧操作；旧 close 保留原 openId |

同步补充了按需作者目录中已有公共 surface 的准确声明和短例，帮助创造者调用已存在的能力；没有新增 SDK、IPC、MCP 连接协议、子会话协议或多模态能力。复杂业务仍归插件，不加 AutoBiz 分支。

## 运行验证

| 范围 | 结果与实际证据 |
| --- | --- |
| 已安装入口 A | 3 个 main 文件 34 项通过；实际 plugin-start-use 浏览器 33 条检查通过。包含纯 Hook/MCP、混合 Function Mod 门禁、空插件、原设置、项目开关、busy 和迟到身份变化 |
| 创作与源码准备 B | 状态/source-set 24 项通过；完整 creator-workspace 与 development 浏览器通过。包含保存页→新审批→同 key 刷新→一次精确批准、源码和聊天共存、unknown 只核对、active 入口撤销后拒绝及成功关闭创作弹窗 |
| 现有表面 C | API 4 文件 35 项、意图 6 项通过；原 platform-workspace 浏览器 22 场景通过；新增连续浏览器 5 段通过 |
| 新界面整链 | 实际 InstalledChatPluginUse→共享入口→实际 PlatformWorkspace 打开/操作/关闭，保留原聊天草稿；同来源两个 capability 的 surfaceId 相同仍打开所选第二项；同 tick 连击和后台刷新仅打开一次；账号/目录/birth 改变后清理迟到旧 frame，不误关新页面；generation 变化不替换成同名新入口；错误/空目录有真实去向 |
| 原流程保护 | 原项目 form/Feature、插件管理、侧栏四套浏览器通过。Host/原服务准入/设置覆盖层/配置作用域共 23 个独立用例分别通过 |
| 静态检查 | 最终完整 Node/Web typecheck exit 0；各负责人修改文件 ESLint 无 errors、diff 检查通过；旧大文件的既有格式 warnings 保留 |

开发中的新浏览器两次定位失败是选择器混淆 Entry/Workspace 文案、或 exact 匹配了含按钮的父节点；通过实际 DOM 和操作记录确认产品已正确拒绝或显示空结果后，修改为可见 Workspace 的语义断言。最终独立回检在修正后的完整测试上通过，未删除对应负例。

原服务准入测试首轮并行冷导入超过测试 beforeEach 默认 10 秒，引发后续夹具 runtime/SQLite 清理级联错误。原生 Host、配置和设置其他 20 项已通过；服务准入单独以 30 秒 hook 限额、单 worker 复验 3/3 通过。仅调整此次测试命令，没有改产品超时、原项目实现或业务断言。原始失败日志保留。

## 独立 medium 回检

- continuity_ux_medium：独立重跑状态/声明 15 项、插件开始使用和完整创作工作区浏览器，查看 375px 批准和源码 unknown 截图。确认门禁、真实状态、入口可达和弹窗关闭，无 P1/P2。
- continuity_surface_medium：独立重跑表面 API 35 项、意图 6 项、旧 Workspace 22 场景和新整链 5 段；核对当前 provider/digest、完整 key、一次性意图、同步锁及迟到清理。确认冻结测试最后只有格式化差异，无 P1/P2。

冻结新浏览器 SHA-256：ED647CD30F6608BB38186E7C214E81D189C13E45F51C978AC585B2EF4FC98A2E。

测试组存在交叉，不相加当作不重复总数。浏览器使用真实 React/CSS 与受控公共 IPC；Host/SQLite、注册表和 VM 窄回归按各套实际运行记录。没有声称原用户真实模型请求或整套业务端到端已验收；集中真实模型验收仍按路线第三阶段安排。本轮没有运行全部 npm test、构建安装包或触发 Actions。

## 原项目与版本保护

本轮开始及完成后比对以下文件 SHA-256，内容完全一致：

- renderer/components/harness-board/HarnessBoardView.tsx
- renderer/components/harness-board/NativeFeatureReview.tsx
- main/harness-board/native-harness.ts
- main/harness-board/service.ts

完整比较记录位于 output/mods-continuity-phase1/original-project-files-before.json 与 original-project-files-after.json。这证明本轮没有改这四个原项目核心实现；另以上述回归验证其行为。

应用版本保持 2.0.0，原微信插件、D 盘作者源和可导入 ZIP 内容不变。仅更新 D 盘使用/验收说明；新入口需要运行更新后的平台代码。

## 复查入口和资料

- 单独复查本阶段的主要浏览器路径：`npm run test:mods:continuity`。
- 新表面连续浏览器已加入既有 `test:creator-flow`，可由正常 npm test 路径访问。
- 截图/报告：output/plugin-start-use-browser、output/creator-workspace-browser/1793505694415、output/platform-surface-continuity-browser、output/mods-iteration-20261015/platform-workspace、output/plugin-management-routing-browser。
- 系统 TEMP：continuity-a-main.log、continuity-a-browser.log、creator-continuity-b-state.log、creator-continuity-b-workspace.log、platform-continuity-api.log、platform-surface-intent-tests.log、platform-surface-continuity-browser.log、platform-workspace-continuity-browser.log、mods-continuity-original-host-settings.log、mods-continuity-host-admission-serial.log、mods-continuity-original-ui-regression.log、mods-continuity-final-typecheck.log。

后续按 [路线](mods-next-iteration-roadmap-2026-11-01.md) 第二阶段，另行评审页面、MCP、子会话的实质协议缺口；本报告只覆盖第一阶段的现有能力接线。
