# 项目能力包接入实施账本

- 2026-10-11：已核对工作树 codex/mods-v2，HEAD 38ba620565c580f0589b1e9153d0ae266e2eb095；大量既有改动保留。无检测到运行中的测试。套餐剩余 14%，购买余额 57342.2630975000，一次重置未使用。
- 方案已落盘，待两名 medium 独立评审；A/B/C/D 均未开始实现、未验收。只创建本次方案与账本。

- 双 medium 完成方案评审：运行时 APPROVE；产品提出防竞争遗漏普通会话/独立人审的 P2，方案补齐后再次 APPROVE。六个已有目标文件及 Vitest 配置已备份，原工作树状态保存在 output/project-capability-20261011。
- A/B/C 连续实施中：静态声明协议及宿主读取已落盘，项目面板与真实会话回调处理中；新增 Autobiz 与非 Autobiz 两份声明、作者指南和打包来源冻结。未标记任何批次最终验收。
- A 首轮两个文件39项窄测通过，之后新增的边界用例待集中验收。生产阶段执行/Hook/状态写入入口未改。
- package-check-1 隔离导出通过：固定504e327d/1.0.87，增强包1.0.87-mods.2；306个原文件（除插件清单扩展）SHA一致，其中109个Hooks相关文件；上游漂移在输出前拒绝。该次使用默认Node24，后续统一Node22重验，不作为最终Node政策验收。
- root静态检视发现当前节点done仍可有合法下一技能，不能一律禁用；另发现刷新期间临时disabled可能遗留busy，已交产品agent修正并补回归。

- A/B/C 实现完成，D集中验收进行中。运行时交叉审C APPROVE；产品交叉审A/C APPROVE。B交叉确认新入口会话创建成功后IM grant抛错导致重复创建的P2，新增仅供新入口使用的wrapper保留已创建会话ID，真实helper路径回归覆盖；旧UAT helper与新增会话按钮未改。
- focused integration1/2均60/60单测通过；browser首次因夹具JSX缺括号失败，修复后暴露Feature切换时序问题。Panel改useLayoutEffect在卸载commit立即废弃旧scope，浏览器增加commit内释放旧请求的真实回归，保留0误导航/0额外创建断言。原日志保留。
- browser-3交互通过但root查看截图发现夹具未扫描到组件Tailwind样式，不能作为体验验收。显式扫描组件源码并加入computedStyle断言后browser-4通过，证据browser-1791689480915：按钮/卡片样式、桌面两列、375px一列、无横向溢出、0页面错误。产品medium实际查看两截图后APPROVE，无P2+。
- Node22 typecheck-standalone-1 Node/Web均通过，Web开始前已包含最终useLayoutEffect变更；build-1通过。随后仅修改测试/文案，不修改生产源码。Node22 package-check通过：306原文件一致，109 Hooks相关，固定源版本和漂移拒绝正确；新zip位于package-1791689427817/accepted。
- 范围lint-1发现新测试mock未用参数，改成明确函数泛型后lint-2退出0。17614条警告主要来自原大文件CRLF/既有格式，未扩大格式化存量文件。新文件已范围格式化。
- 3691个源/测试/示例/脚本等文件冻结于source-final.json。唯一full session85861运行完整npm test等价链（Vitest并发2），追加官方示例与项目能力浏览器回归；不并行测试、不改冻结源码。尚未全量验收，不标记最终完成。
- full85861发现首个失败：langchain-native-tool-invoke-origin.test.ts 的node-first CJS加载用例4514ms失败于spawnSync result.error非空，原子进程timeout4500ms。runtime medium只读确认测试旧快照/当前SHA一致，旧整文件24项1178ms通过；子进程不加载本轮项目能力代码。尚待主测试结尾完整错误码，不能提前认定根因；全链结束后再原样复验完整文件，不改断言或期限。

## 最终验收（2026-10-11）

- full85861已关闭exit1：主Vitest 11836通过、1次子进程ETIMEDOUT、51跳过，1158文件通过、1失败、5跳过，耗时1415.78秒。原始完整记录保留full-regression/result.json，未改写为全绿。
- 主测试之后18组独立回归全部exit0：采纳、消息、Hooks、插件、任务卡片、合并、工作流、桌面Agent、IM、Flow恢复、创作、实际安装、文件操作、评测、Skill评测、UI、官方示例和项目能力。项目能力再次60/60及真实浏览器通过。源码完整性3691文件changed=[]。
- 全链结束后原样完整文件复验24/24通过：node-first524ms、agent-first527ms；原4500ms及所有断言未修改。recheck-result.json测试与完整性均0。结论仅为原样复验通过，不宣称历史时序抖动根因已永久消除。
- 双medium已独立最终签收APPROVE，实际代码、有效截图、交互回归、原Hook保留和最终测试证据在本次支持范围内无未解决P2+。报告为output/project-capability-20261011/product-review.md与runtime-review.md。
- A/B/C/D本次约定范围均完成：静态通用声明及有界宿主接入、原项目入口控制台、两个示例/中文指南/冻结导出、集中回归与交叉评审。通用事务引擎、任意Python自动转换、旧native适配接管新版阶段不属于本次交付承诺。
- 最终分支codex/mods-v2、HEAD38ba620565c580f0589b1e9153d0ae266e2eb095保持；未改UAT或外部Autobiz仓库（外部git状态仍干净），未自动提交混合工作树。无本次运行中的测试。
- 最后额度查询ordinaryUsageAllowed=true，工具报告套餐usedPercent=0；购买余额57342.2630975000与开始相同、重置机会仍1。本轮未调用额度重置工具。
- 增强包：output/project-capability-20261011/package-1791689427817/accepted/AutobizDevOps_Plugin_Kanban_Fullstack0920_Mods.zip，版本1.0.87-mods.2。306个原文件逐项SHA保持，其中109个Hooks相关文件。完整交付索引见delivery-final.json。

## 开发者入门说明补充（2026-10-11）

- 根据用户新要求，新增 `docs/sparks/plugin-cookbook.md`，按从零插件、项目说明、跨插件组件/动作复用、旧阶段依赖迁移四个练习组织；包含可复制文件、安装点击步骤、预期结果、失败排查及可交给助手的需求模板。
- 新增完整最小插件 `examples/sparks-hello`；应用官方说明新增“插件开发入门”章节，概览、安装复用、旧插件适配、项目指南与参考示例均有入口。没有修改业务执行、Hooks、状态提交或 UAT 分支。
- 原两名 medium 评审分别对操作体验和协议/真实动作契约只读复检，均 APPROVE，无本轮未解决 P2+；采纳更明确的“执行流程”操作文案。
- Node22 定向 20/20 通过：教程与示例逐字一致、项目 JSON 生产解析、最小插件真实编译及 GuestRuntime 命令输出、组件依赖/投影和文档链接。首次测试漏计 `next` 宿主链调用，修正测试期望后通过，示例执行代码未改。
- 真实文档浏览器回归通过：9 章离线加载、新教程链接、代码块、Hooks 指南、搜索、返回、翻页、窄屏及草稿保留，无页面错误或网络请求。证据为 `output/plugin-cookbook-20261011/browser.log` 指向的 result.json。
- 范围 lint 退出 0，0 错误、55 格式警告（现有阅读器及浏览器测试格式）；未整文件重排格式。此次为文档/独立示例/章节接入增量，采用相关回归，不将此前完整业务回归结果冒充此次新跑的全量。
- Web TypeScript 检查退出 0（`output/plugin-cookbook-20261011/typecheck-web.log`）。本次浏览器/类型检查进程已结束，无待运行测试。
