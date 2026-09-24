# Mods v2 实施状态 — 2026-09-24

代码基线 `40fabd88` 后的文件读取模式修复（宿主修订v65），分支 `codex/mods-v2`，仅修改 `C:\ai\CmbCoworkAgent-mods-v2`。UAT 工作树未修改或合并。本文替代旧文档中“当前状态”的历史数字；不代表最终发布通过。

兼容表已逐项补足范围说明，共245条：49 adapted、155 partial、41 unsupported、0 full。15个classic事件仍仅schema/手动分发；详见[兼容边界复核](mods-v2-compatibility-review-2026-09-24.md)。没有把未实现项列为完成。

长稳探针已补有界可信原生事件和失败快照；节点替换测量缺陷先红再绿，真实24事件/3重载及50历史/200确认通过。原6408事件实际确认丢失仍未定位，不能据此宣称两小时门禁通过。

## 应用已具备的能力

- [文件读取模式](mods-v2-file-read-options-2026-09-24.md)：默认/显式text保留到operation，非法选项及不支持的bytes在真实host读取前拒绝，Hook改写同样校验；保留旧path-only改写与强制发布过滤。未实现二进制读取，仍partial/bounded。

- [Guest Base64](mods-v2-base64-2026-09-24.md)：hooks/独立Client中只读atob/btoa，真实字节向量、padding/错误及原型修改回归；纯guest计算，保持资源限制，不增加宿主权限。仍partial，不包含DOMException或文件bytes读取。

- 关闭经典Function桥时直接保留原生Hook路径，继续检查取消/session变化；全局及项目关闭时原生HTTP拒绝各只执行一次。完整Electron228与全hooks68通过，性能尾延迟仍未全部达标。

- [Client并发忙态](mods-v2-client-busy-2026-09-24.md)：真实输入迟到不再提前解锁仍等待宿主的按钮/提交/选择；关闭和新实例的状态隔离保持。不是原长稳ACK丢失根因声明。

- [Guest 代码生成限制](mods-v2-guest-codegen-2026-09-24.md)：在 hooks/Client 插件代码运行前拒绝 eval/Function 及间接构造器路径，保留正常函数、生成器和异步 SDK；宿主修订 v63 绑定批准摘要。只影响 Function Mods 的 QuickJS，未修改应用 JavaScript 环境。
- 独立 utility process / QuickJS、插件摘要授权、真实 FunctionSession、runtime authority、generation 和原线程 run lease。取消、撤权、替换和关闭会中止旧操作；关闭模块不扫描插件、不创建 Mods runtime。
- 主 Agent 的真实模型流与 turn.step，受限 model.fork/classify，实际 agent registry 的 agent.offer；不能把模型文本中的 PASS 当作测试回执。
- [实际子 Agent 实例](mods-v2-agent-list-2026-09-24.md)：当前观察周期内 shared child 的真实 ID、元数据、父子关系和 running/completed/failed/killed；原取消/撤权和发布复核，超限拒绝查询但不阻断原任务。不是全部执行器任务目录，仍 partial/bounded。
- [文件写入 SDK](mods-v2-file-write-2026-09-24.md)：显式用户非 immediate 命令通过原生审批/write_file/receipt；真实租约实例、同项目/线程且仍活跃的作用域复核。审批期撤权/取消/释放或交接拒绝落盘；晚到拒绝不承诺回滚。保留原参数上限，仍 partial/bounded。
- [文件元数据](mods-v2-file-metadata-2026-09-24.md)：项目内 stat/list 的真实 isLink、可选 canonical realPath、严格 resolve 选项与发布后节点/目标复核，保留旧 hook 形状；文件 SDK 仍 partial/bounded。
- session 读取、显式压缩与 checkpoint、真实模型请求的 MCP/memory/skills/agents 动态来源 breakdown；token 估算与 provider usage 分列，无成本数据时不伪造费用。
- 内建工具使用本应用的真实参数和权限；注册工具支持有界 JSON Schema，包括本地 defs 引用。不宣称 Claude 工具名称、所有 schema 关键字与输入输出完全等价。
- [UI 重绘 operation](mods-v2-ui-invalidate-2026-09-24.md)：void SDK 进入原 dispatch，before-next 拒绝、取消、撤权与关闭阻止迟到 core；仅 ui.render 范围，不回滚晚到拒绝前已发生的重绘失效。
- [公开 JSX factory](mods-v2-public-jsx-2026-09-24.md)：hooks/Client 的 readonly h/Fragment 与原编译别名共享实现，Fragment 列布局；直接 h(Client, literalProps) 在安装扫描时纳入批准摘要，动态/越界路径拒绝。旧独立 Surface 复用工厂且保留状态/计时器；string tags、任意 factory 别名与完整 upstream JSX 类型声明仍未支持。
- [Client 通知范围](mods-v2-ui-notifications-2026-09-24.md)：独立Client更新不再触发无关FunctionSite查询；原合并队列全局优先，显式重绘/站点动作/配置/旧Mods通知保持原行为。未绕过授权或发布复核。
- [Client 主动焦点](mods-v2-imperative-focus-2026-09-24.md)：原 Pane SDK 扩展到同插件 Client 控件，绑定真实实例/控件句柄并复核原始与改写目标，实际 DOM 双确认保留键盘归属、人意图和生命周期约束。完整嵌套焦点观察与非桌面仍不支持。
- Pane、十三个非 Pane 桌面站点、受限 Code/Svg、Client 生命周期和焦点/滚动。terminal/vscode/mobile 与不支持的站点不伪装成桌面兼容。
- classic 生产触发器逐项记录。已补 PostToolBatch、InstructionsLoaded、UserPromptExpansion、sessionTitle、工具观察、Stop/StopFailure、Pre/PostCompact 等链路；仍未接入生产的事件明确保留 partial，不能凭手动 dispatch 宣称支持。
- [应用项目完成规则](mods-v2-application-completion-rules.md)：四模式、四范围、检查选择、修复/时间/模型预算、项目持久化与执行证据。采集步骤具有开始/终结记录，真实进程退出后重新打开 SQLite 不会把中断当作 PASS。
- 可选 Autobiz 阶段推进接入原完成循环：固定 compiler 推导终点，真实 validator 和文件证据复核后通过原生审批提交。重复完成只复检；跨项目相同完成键分别留存回执。

## 验证事实

| 验证 | 已知结果与边界 |
| --- | --- |
| 文件读取模式 / Mods62 | 先真实guest/session 14红1兼容绿、旧普通Electron模式断言红；相关56窄测、新普通Electron3、164文件1424项、utility46、完整Electron234、Node/Web/helper types及差量lint通过。后续检视发现显式undefined回归，先真实guest/Electron红再补桥接；补后78窄测、Mods63 164/1425与utility46通过；最终Electron首轮223项后被整套15分钟watchdog中断，改普通完整套件20分钟后最终234检查通过并恢复ordinary，单项/业务/性能门槛未变。首个正式性能在未完成idle窗口时主动中断，不算预算结论；最终正式桌面性能因会话中断无完整回执；随后smoke TTFT +51.3ms、qualified=false/passed=false，不算性能通过 |
| Base64 / Mods61 | 先真实QuickJS及旧Electron失败，再163文件1409项、utility46、完整Electron232通过；Node/Web/helper types和差量lint通过，性能回检记录见独立报告，不替代正式发布门禁 |
| 关闭经典桥 / Mods60 | 156文件1378项、utility44、完整Electron228、全hooks10文件68项、Node/Web/helper types与差量lint通过；正式ingress关闭2/10仍失败，保留失败，不称最终性能通过 |
| Client忙态 / Mods59 | 先旧普通Electron真实并发断言失败，再专项4项通过；完整Mods152文件1333项、utility44、完整Electron226全通过。新UI构建性能smoke +65.2ms、qualified=false/passed=false；不描述为新构建正式性能通过 |
| Actions包内门禁 | Windows既有打包后新增ASAR/Electron验证，失败阻断该job发布，限定上传回执/PNG；runner/workflow/staging 18项、helper types与差量lint通过。未push/触发Actions，实际新包与安装验收未完成 |
| Guest 代码生成限制 | 先真实guest红4/1、旧普通Electron执行字符串红；窄测4文件39项通过，Node/Web/helper types与修改行ESLint通过，新普通Electron专项5通过；完整Mods57含renderer为151文件1329项通过，真实utility42与完整Electron223通过；独占性能结果见独立报告 |
| 公开 JSX factory | guest、loader、旧Surface均有先失败测试；相关3文件22项、完整Mods56含renderer为150文件1323项及真实utilityProcess通过；最终普通包公开JSX5/通知范围4/Client焦点9通过，smoke TTFT+65.4ms且qualified=false/passed=false；详见独立报告 |
| Client 通知范围 | 先红后绿，相关6文件30项窄测；Mods54含5个renderer文件149文件1314项及utility41通过；普通旧包IPC范围红→新普通包专项4通过；Client焦点9/重绘6/50条历史200确认专项4通过；smoke TTFT+66.3ms，qualified=false/passed=false，详见独立报告 |
| Client 主动焦点 | 真实guest/session先14项红，扩展后新15+原30+renderer2共47窄测通过；完整Mods53含renderer为144文件1298项、utilityProcess41项通过；新实际Electron专项9检查通过；原生焦点9/重绘6专项通过；性能smoke TTFT+51.8ms，qualified=false/passed=false；不借用v61完整204作为v62全量结果 |
| ui.invalidate | 真实guest/session14项、完整Mods52四worker142文件1281项、utilityProcess41项通过；普通包专项6与完整Electron204检查通过，含等待中关闭；Node/Web/helper types及修改行ESLint通过。性能短测结果见独立报告，未替代正式门禁 |
| 命令历史容量 | 新真实guest/session先红后绿，普通旧包Electron先红，新包50条历史/200次Client确认/重载/off专项4通过；完整Mods51四worker 141文件1267项通过、隔离manager47/真实utility41通过；完整Electron199通过；性能smoke TTFT +36.3ms，qualified=false/passed=false，不更新正式门禁。默认并行首轮两项5秒超时保留在报告 |
| agent.list | 最终窄测 4 文件 65 项、Mods49 141 文件 1266 项、真实 utility process 41 通过；实际 Electron 专项 8 检查、完整 Electron 199 检查通过；独占性能 smoke TTFT p95 +69.0ms / 吞吐比0.997205，qualified=false、passed=false，不替代正式门禁 |
| fs.write | 完整 Electron 192 检查通过；该轮早于最终跨作用域租约补丁，补丁后的实际 Electron 写入专项另有 7 检查通过。最终 Mods48 139 文件 1235 项通过；真实 utility process 41 与原 lease standalone 6 通过 |
| Mods47 | 139 文件 1233 项通过，随后跨作用域/已结束调用两个红测修复后，相关 4 文件 57 项通过；最终完整回归见报告 |
| Mods46 | 默认 Mods 范围136文件1207通过，另 renderer 滚动竞态1文件2通过；外部SQLite撤权/epoch/摘要变化与连接生命周期覆盖 |
| Mods45 | 136 文件、1205 测试全部通过，包含文件元数据、并发替换/取消/撤权与真实 guest/session |
| Mods44 | 135 文件、1197 测试全部通过，新增真实 guest/session 后台任务冻结/回拨墙钟超时回归 |
| Mods43 | 135 文件、1195 测试全部通过，包含主动滚动/持续跟随与 renderer ACK 竞态检查 |
| Mods42 | 131 文件、1143 测试全部通过；随后新增空字符串 focus deny 回归先失败、修复后窄测 3 文件 32 项通过 |
| Mods38 | 130 文件、1087 测试通过，覆盖原生 checkpoint 权限桥及单调完成预算 |
| Mods39 | 130 文件，1103 通过、4 失败；错误顺序兼容修复后两个相关文件 67/67 通过，其余 128 文件此前通过 |
| 完整 Electron grant-query | 186检查通过，普通out恢复；授权查询复用保留撤权/取消/重载及原生执行/关闭对照 |
| 完整 Electron file-metadata | 186 检查通过，普通 out 恢复；真实链接、改写、项目边界和关闭原生读对照，另真实 utility process 41 检查通过；旧 helper 的撤权只使 session 失效，真正撤权已在 7363ce1e 更正并重跑 5 项通过 |
| 完整 Electron background-timeout | 182 检查通过；实际后台超时、关闭原生执行对照及此前功能全部回归，普通 out 恢复 |
| 完整 Electron scroll | 最终滚动/focus/存量业务链路 180 检查通过，含取消/重绘、持续跟随、竞争、重载、撤权与关闭对照 |
| 完整 Electron focus-2 | 172 检查通过；随后空 deny 修复的最新普通构建专项 9 检查通过，真实 DOM、取消/撤权/重载和关闭对照保留 |
| 完整 Electron34 | 161 检查通过；早于自动阶段功能，不能算其验收 |
| 自动阶段 Electron | 12 检查通过：原生工具回执、文件失效、关闭对照、审批拒绝、实际 validator/CAS、重复完成；是契约夹具 |
| 配置 Electron | 10 检查通过，包含四模式/范围、阶段配置、清除推进及真正 Electron 重启后的项目规则/管理锁 |
| 真实业务演示 | 实际 deepseek-v4-flash、原审批与 Agent 修复循环；规则关闭时真实缺陷未修，开启后 1 次自动修复、7 项独立业务断言通过，真实 validator 通过后仅推进 1 次 checkpoint。受保护需求/测试/脚本未变；不是全面业务能力证明，见[演示报告](../output/mods-v2-validation/2026-09-24-real-business-demo.md) |
| TypeScript / ESLint | 授权查询复用：Node/Web通过，ESLint无错误、新测试无警告，control-store原3个警告经HEAD比较未增加。此前各能力helper类型和历史格式警告详见各自报告 |
| 全仓回归 | 先前完整 Vitest 存在基线失败；隔离后剩 26 项已在旧基线复现，standalone 84 命令初次 78 通过、6 失败，修复 2 个本分支差异后相关整套通过，其余 4 个在旧基线复现；不能称全仓全绿 |
| 性能 | 最新正式 ingress 的单插件 p95 五轮均低于 15ms，但关闭对照关闭经典桥修复后复检有2/10组超预算（最大project-off +7.7271% / +0.1760ms），之前a447abe0的4/10失败保留，整体未通过；修复前3c569546冻结v63正式桌面门禁qualified=true/passed=true：关闭/开启各50样本，TTFT p95 +25.7ms、吞吐比0.994927、两组300秒CPU差-0.063676百分点；[正式报告](../output/mods-v2-validation/2026-09-24-v63-formal-performance.md)保留此前full4 +67.7ms失败，未将通过归因于单一改动；正式 soak 在6407事件/25次切换/约77分钟时因Client确认超时失败，尚未通过两小时/10000事件门禁 |

7363ce1e 已更正 metadata/write 两个 Electron helper 的撤权参数，并增加实际授权状态断言：新专项 5+7 检查通过。旧测试只证明 session 失效，不能冒称撤销了持久化 grant，见[更正报告](../output/mods-v2-validation/2026-09-24-function-revocation-e2e-correction.md)。

报告保存在 `output/mods-v2-validation/`，每份标明对应代码、范围和失败。契约测试中的本地 HTTP 模型服务与业务产物夹具不能算真实业务验收；上表单列的真实业务演示使用实际 provider 与独立业务断言。checkpoint 提交现保存开始、成功、失败与已写入但权限失效的中断事实，重启不自动重放未知操作。

正式长稳原始失败及内存测量边界见[失败记录](../output/mods-v2-validation/2026-09-24-desktop-soak-failure.md)。命令历史50条与CommandOutput旧32槽冲突已独立复现；不能据此直接认定点击超时原因。

## 仍未完成的工作

2026-09-24 用户明确允许延期复杂且不影响正常使用的边界功能。后续按[核心交付范围](mods-v2-core-delivery-scope-2026-09-24.md)收尾，兼容缺口保留原状态；不取消权限、证据、checkpoint 正确性或失败记录。

1. 继续处理兼容矩阵中未接入的生产事件与剩余 SDK/UI 差异；[SDK 逐项边界](mods-v2-sdk-boundaries-2026-09-24.md)已区分已有受限实现与未开放接口。主动 `$.ui.focus` 已接入原生桌面 Pane 及其 Client 控件，仍不支持 AbovePrompt/非桌面目标；`$.ui.scroll` 已接入原生 Pane 的测量、实际位置确认与 end 跟随，其他 site/转录/Client key 和 person wheel 新契约仍未对齐；以字段、时序、错误/取消和实测证据为准，不批量升级 partial。
2. checkpoint 已具备只读恢复核对界面；未知提交的自动协调/回滚仍未提供，外部文件竞争必须保留保守失败边界。
3. 桌面性能正式v63基线已通过；ingress关闭性能、长稳门禁及最终代码检视仍需完成，全仓既有失败仍须单独标注。
4. [GitHub Actions包内门禁](mods-v2-actions-package-validation.md)已接线并完成runner回归，实际Actions安装包和安装验证仍待执行；本地NSIS不作为开发阻断，不把普通构建/Node夹具通过描述成已交付安装包。

## Claude 参考与差异

2026-09-24复核官方参考为 v2.1.280，提交 `56f36532530f88b572854538d685fcf781141e8c`；声明文件头仍2.1.277，与v2.1.278逐字节相同。README收紧内建telemetry范围，详见[最新参考复核](mods-v2-claude-reference-2026-09-24.md)及[逐项兼容矩阵](mods-v2-compatibility-matrix.json)。completion.check、应用项目规则和 Autobiz adapter 是本应用扩展，不构成 Claude 同名兼容声明。
