# Bot 任务行预览与会话跳转

2026-11-19，在 macOS 上使用 App 1.5.7、Electron 39.8.10、Node 25.5.0。基线为 `codex/merge-uat-into-bot-beta` 的 `c329ed9c2`，叠加本次工作区改动。

## 交互和结果

本地 App 的任务列表将任务行设为预览入口，尾部箭头常驻，独立打开该任务对话。私聊和两个招乎群分别创建一项「同名周报」，将各自的核对结论写入原任务。使用隔离资料目录、真实 Electron 渲染器、IPC 和 SQLite。模型及企业招乎网络未参与。

| 输入 | 实际结果 |
| --- | --- |
| 在私聊点任务标题，在两个群分别点状态文字、左侧状态图标 | 三次均打开预览，原主对话仍在，只读到当前任务对应的核对结论。 |
| 在私聊点行内左上留白，通过空格再次预览 | 均进入预览。返回后焦点回到任务行。 |
| 私聊从任务行按 Tab 后按 Enter，群聊直接点右侧箭头 | 均打开对应任务对话。群预览底部的「打开聊天」也进入正确任务，可返回原群。 |
| 打开任务 A 后，在详情面板预览任务 B，再返回列表 | A 的对话仍在，预览内容来自 B。补充用例验证 B 读取失败时错误仅显示在预览。 |

## 复现与证据

- 用 `node scripts/run-bot-integration-e2e.mjs --build-only` 构建，设置 `BOT_TEST_APP_OUT` 为输出目录后，运行 `node --import tsx tests/bots-details-cards-app.spec.ts`。退出码 0，记录 `PASS: three identically named tasks, each preview reads only its own original thread`。三份分域截图位于该次构建的 `artifacts/scope-preview-{0,1,2}.png`。
- 运行 `node --import tsx tests/bots-work-directory-browser.spec.ts`，覆盖 45 条任务翻页、搜索和延迟响应，退出码 0。目录夹具记录 `calls: 10, maxBatch: 5, maxInFlight: 1`。
- 运行 `npm run typecheck:web`，退出码 0。Vitest 的 `work-preview`、`work-create-preview`、`work-approval-navigation`、`work-directory` 和 `bot-skill-target-recovery` 五个文件共 124 条通过。

初次回归发现，群主对话测试依赖私聊专用 DOM 标识，导航夹具也缺少会话范围及按钮的 DOM 方法。测试已按两类会话各自的页面元素和实际按钮契约修正，再执行上述验证。
