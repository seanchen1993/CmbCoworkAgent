# Mods v2 实施状态 — 2026-09-24

代码基线 `ae834f7d`（随后 ui.invalidate 桥接见本次提交），分支 `codex/mods-v2`，仅修改 `C:\ai\CmbCoworkAgent-mods-v2`。UAT 工作树未修改或合并。本文替代旧文档中“当前状态”的历史数字；不代表最终发布通过。

## 应用已具备的能力

- 独立 utility process / QuickJS、插件摘要授权、真实 FunctionSession、runtime authority、generation 和原线程 run lease。取消、撤权、替换和关闭会中止旧操作；关闭模块不扫描插件、不创建 Mods runtime。
- 主 Agent 的真实模型流与 turn.step，受限 model.fork/classify，实际 agent registry 的 agent.offer；不能把模型文本中的 PASS 当作测试回执。
- [实际子 Agent 实例](mods-v2-agent-list-2026-09-24.md)：当前观察周期内 shared child 的真实 ID、元数据、父子关系和 running/completed/failed/killed；原取消/撤权和发布复核，超限拒绝查询但不阻断原任务。不是全部执行器任务目录，仍 partial/bounded。
- [文件写入 SDK](mods-v2-file-write-2026-09-24.md)：显式用户非 immediate 命令通过原生审批/write_file/receipt；真实租约实例、同项目/线程且仍活跃的作用域复核。审批期撤权/取消/释放或交接拒绝落盘；晚到拒绝不承诺回滚。保留原参数上限，仍 partial/bounded。
- [文件元数据](mods-v2-file-metadata-2026-09-24.md)：项目内 stat/list 的真实 isLink、可选 canonical realPath、严格 resolve 选项与发布后节点/目标复核，保留旧 hook 形状；文件 SDK 仍 partial/bounded。
- session 读取、显式压缩与 checkpoint、真实模型请求的 MCP/memory/skills/agents 动态来源 breakdown；token 估算与 provider usage 分列，无成本数据时不伪造费用。
- 内建工具使用本应用的真实参数和权限；注册工具支持有界 JSON Schema，包括本地 defs 引用。不宣称 Claude 工具名称、所有 schema 关键字与输入输出完全等价。
- [UI 重绘 operation](mods-v2-ui-invalidate-2026-09-24.md)：void SDK 进入原 dispatch，before-next 拒绝、取消、撤权与关闭阻止迟到 core；仅 ui.render 范围，不回滚晚到拒绝前已发生的重绘失效。
- Pane、十三个非 Pane 桌面站点、受限 Code/Svg、Client 生命周期和焦点/滚动。terminal/vscode/mobile 与不支持的站点不伪装成桌面兼容。
- classic 生产触发器逐项记录。已补 PostToolBatch、InstructionsLoaded、UserPromptExpansion、sessionTitle、工具观察、Stop/StopFailure、Pre/PostCompact 等链路；仍未接入生产的事件明确保留 partial，不能凭手动 dispatch 宣称支持。
- [应用项目完成规则](mods-v2-application-completion-rules.md)：四模式、四范围、检查选择、修复/时间/模型预算、项目持久化与执行证据。采集步骤具有开始/终结记录，真实进程退出后重新打开 SQLite 不会把中断当作 PASS。
- 可选 Autobiz 阶段推进接入原完成循环：固定 compiler 推导终点，真实 validator 和文件证据复核后通过原生审批提交。重复完成只复检；跨项目相同完成键分别留存回执。

## 验证事实

| 验证 | 已知结果与边界 |
| --- | --- |
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
| 性能 | 最新正式 ingress 的单插件 p95 五轮均低于 15ms，但关闭对照仍有 1/10 组超预算（project-off +14.584% / +0.3574ms），整体未通过；checkpoint 共享快照优化后正式桌面 full4 采样有效，CPU 增量 0.098856 单核百分点及吞吐比 0.996589 通过，TTFT p95 增量降到 67.7ms，仍超过 40ms 门槛；正式 soak 在6407事件/25次切换/约77分钟时因Client确认超时失败，尚未通过两小时/10000事件门禁 |

7363ce1e 已更正 metadata/write 两个 Electron helper 的撤权参数，并增加实际授权状态断言：新专项 5+7 检查通过。旧测试只证明 session 失效，不能冒称撤销了持久化 grant，见[更正报告](../output/mods-v2-validation/2026-09-24-function-revocation-e2e-correction.md)。

报告保存在 `output/mods-v2-validation/`，每份标明对应代码、范围和失败。契约测试中的本地 HTTP 模型服务与业务产物夹具不能算真实业务验收；上表单列的真实业务演示使用实际 provider 与独立业务断言。checkpoint 提交现保存开始、成功、失败与已写入但权限失效的中断事实，重启不自动重放未知操作。

正式长稳原始失败及内存测量边界见[失败记录](../output/mods-v2-validation/2026-09-24-desktop-soak-failure.md)。命令历史50条与CommandOutput旧32槽冲突已独立复现；不能据此直接认定点击超时原因。

## 仍未完成的工作

1. 继续处理兼容矩阵中未接入的生产事件与剩余 SDK/UI 差异；[SDK 逐项边界](mods-v2-sdk-boundaries-2026-09-24.md)已区分已有受限实现与未开放接口。主动 `$.ui.focus` 已接入原生桌面 Pane 控件，仍不支持 AbovePrompt/Client 目标；`$.ui.scroll` 已接入原生 Pane 的测量、实际位置确认与 end 跟随，其他 site/转录/Client key 和 person wheel 新契约仍未对齐；以字段、时序、错误/取消和实测证据为准，不批量升级 partial。
2. checkpoint 已具备只读恢复核对界面；未知提交的自动协调/回滚仍未提供，外部文件竞争必须保留保守失败边界。
3. 性能预算、长稳门禁及最终代码检视；全仓既有失败仍须单独标注。
4. GitHub Actions 安装包和安装验证；本地 NSIS 不作为当前开发阻断，也不把普通构建通过描述成已交付安装包。

## Claude 参考与差异

当前固定官方参考为 v2.1.278，声明文件头 2.1.277，提交 `bf7d404e26a5fb6167d21b46c93a2bf6c22ab274`。详见[最新参考审查](mods-v2-claude-latest-audit-2026-09-22.md)及[逐项兼容矩阵](mods-v2-compatibility-matrix.json)。completion.check、应用项目规则和 Autobiz adapter 是本应用扩展，不构成 Claude 同名兼容声明。
