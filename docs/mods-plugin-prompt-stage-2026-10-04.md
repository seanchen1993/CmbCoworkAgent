# 阶段19：组件主动提交任务

状态：实现、运行验证及两位最终独立证据/静态检视均通过；持续目标没有结束。开发目录 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`，UAT只读。没有提交或发布。

## 实际效果

组件的界面操作和完成通知可以安排一条新的完整聊天任务。原任务忙时等待，真正空闲后执行，沿用当前模型和项目权限。界面、数据库和 UserMessage 规则保留真实组件来源；隐藏参考信息只给模型。普通聊天、既有 Plugin、项目模式和 Harness 继续使用原入口。

使用和迁移见[操作说明](mods-plugin-prompt-usage-2026-10-04.md)。设计与两位独立方案评审见[设计](mods-plugin-prompt-design-2026-10-04.md)。当前宿主版本为 v86；历史阶段18的 v85 证据没有改写成新结果。

## 已取得的实际证据

- 原版固定2.1.289：提交链8项、实际界面来源14项、其它实际来源12项、真实 recurring 回调2项、真实完成通知2项通过。界面第五轮探针已给捕获旧 SDK 的命令调用补上零 child core 与 host check 断言。上层正常返回/抛错不取消已进入子链；上层解除30ms后仍未观察到取消。它们只证明原版实际来源和提交链，**不证明官方空闲调度、真正开始、真实 Stop 或数据库**。
- 本工程 QuickJS、真实私有准备权限、队列与宿主隔离：5文件34项通过，`output/mods-plugin-prompt-host-owner-third.log`。实际 Windows sandbox 改变和同 authority 重绑定，在 core 前/后均会清理无效任务；原文件写入权限没有借给准备入口。
- 完成入口、真实逻辑任务与 checkpoint 来源：4文件48项通过，`output/mods-plugin-prompt-lifecycle-source-first.log`。包含准确 ID/角色/occurrence 来源恢复和人类 Goal 正向；插件同文字不参与人类 Goal 判等。
- 真正 worker 分页及 renderer 来源：2文件15项通过，`output/mods-plugin-prompt-hydration-first.log`；真实 SQL Goal 更新/删除/批量暂停通知1项通过，`output/mods-plugin-prompt-goal-idle-first.log`。
- 真正 Electron：`output/mods-plugin-prompt-electron-seventh.log`13检查点全部通过，其中1个应用开关公共检查、12个本阶段检查。实际安装 ZIP、真正按钮、当前模型 HTTP、重复 next 一次接纳、隐藏 context、drop/无 core、asUser/最终省略 origin、真实 started 早于回答完成、原生完成回调、来源重开、忙时零额外 HTTP、撤权/重授不重放、普通聊天继续均已验证。截图和模型请求保存在同名目录；运行器已恢复普通构建，`out/main/mods-e2e.js`不存在。
- Node/Web 中间类型检查：`output/mods-plugin-prompt-types-fourth.log`通过。最终包括示例和用法的检查见后文，不用中间结果替代最终结果。

## 实际发现并修复的问题

早期真实运行继承已结束的 SDK 活动；完成通知又继承旧提交 scope。现在队列在宿主独立 AsyncResource 中运行，新任务及真正租约清理不借用旧 SDK 状态，完成通知也有自己的入口。原 scope、取消、批准、代码、配置、线程和物理租约检查继续保留。

分页读取、checkpoint 合并曾漏掉来源，造成组件文字被误画成人类 Goal。现在 worker 严格读取实际来源，恢复按准确记录匹配，Goal 判等排除插件文字。重新批准时旧 Session 已清空，过去缺少页面刷新通知；现在批准成功和撤权都会通知原页面刷新，失败批准不误通知。

## 仍保留的范围

文字任务适配普通项目聊天，不替代所有附件和 IM/Goal/内部控制入口。活动 Goal继续占有对话，排队不能抢走它。来源的普通 frame 返回和可恢复规则抛错不撤销接纳；真正撤权、配置变化、线程失效或退出会清理等待项。原版真实 Stop/卸载对照尚未证实，不把本工程安全清理说成完全一致。

排队上限为全局64、对话16、组件每个对话8；同项目组件每分钟20次。没有后台轮询、自动重试或重启重放。SDK 返回等真正开始，运行结束和租约释放仍等真实 completion/finally。

全工程历史 `npm test`和lint存在既有失败，不能写成全部通过。最终冻结广域、存量邻近、性能、lint和两位最终检视结果将在本文件追加。之后继续原生 engine 节点、构造器替换及其它可适配项；目前没有新的不可实现框架限制。

## 最终运行结果

- 冻结受控范围412文件，411通过、1性能默认跳过；3527项通过、1跳过，445.55秒。`output/mods-plugin-prompt-controlled-broad-final.log`与同名scope文本可复核，全部路径在启动前确认存在。不是全工程npm test结果。
- 最终实际Electron：`output/mods-plugin-prompt-electron-ninth-final.log`退出0，14检查点全部通过（1公共+13本阶段）。在原13项基础上，实际资源包queued-review被安装/批准/点击；无关父任务忙时零额外HTTP，自己的开发结束才检视，准确2条持久组件任务且无第三轮循环。第八轮因验收head组件未保留下游而挡住示例按钮，夹具改成真实next组合后通过；该失败日志保留。普通构建已恢复，test-only entry不存在。
- 传统无Mods插件真实Electron：`output/mods-plugin-prompt-legacy-project-final.log`退出0，9检查点全部通过；产物已独立存到同名目录。含原导航/技能与Hook目录开关、真实adapter子进程、项目/需求、worker/产物边界、重启、全局Mods开启共存、原Claw/Flow审批取消、卸载诊断。它不证明外部模型或live MCP质量。
- 存量14个独立脚本全部退出0，`output/stage19-legacy-boundary-latest.json`；10脚本共157个实际PASS/✓标签，另4脚本只有完整完成标记，不能混写成157个总断言。每脚本新进程及独立CMB数据目录。含实际transport/window/lease、流转换、Goal数据库与harness、transcript、checkpoint/fork及消息DB。完整范围与未覆盖项见`output/stage19-legacy-boundary-review.md`。
- Node/Web最终类型检查通过，`output/mods-plugin-prompt-types-final.log`。变更范围85文件lint零错误、12293条既有格式等警告，`output/mods-plugin-prompt-lint-final.log`；未全格式化大型旧文件，不能写成全仓lint干净。
- 独占性能：30次预热、50次采样，每次8条内存接纳+宿主AsyncResource调度+真实队列清理；中位0.2533ms、95分位0.3819ms、最高1.1711ms，结束残留0、busy时stub native runs为0。`output/mods-plugin-prompt-queue-performance.json`。host.run为测试替身，不包含SQLite/guest/IPC/renderer/模型成本。
- 矩阵及用法最终3文件23项通过，`output/mods-plugin-prompt-matrix-final.log`。历史siteClientsAdaptation仍v85，新增pluginPromptAdaptation是v86；全局fullParity保持false。

实际示例源码在resources/mods/queued-review；已验收ZIP为`output/queued-review.zip`，操作说明和截图见上述guide及Electron产物。通用组合可重写任务文字，示例因此采取保守关联；不是检视质量门禁。

后续仍需补充真实活动Goal与HTTP共同唤醒、主动提交接传统Harness的专项模型证据、真实Stop对照、可信fork/import来源复制和renderer来源读取性能；既有局部脚本不能冒称这些全部完成。继续原生engine方案，已获两位正式设计PASS，没有框架限制结论。

`latest_mods_binary_review`与`official_mods_review`已对照最终原始日志/结果和代码分别正式PASS。复核了队列真实宿主finally、来源事务/worker/checkpoint、示例own-turn关联、所有计数及未覆盖范围，没有把本工程真实启动证据写成原版调度或全工程测试通过。`legacy_boundary_review`额外给出了存量风险清单和14脚本实际执行结果。
