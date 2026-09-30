# DevClaw Bot 分支整合与验证记录

2026-09-30 · 本地整合记录

## 一、结果与范围

已在隔离 worktree 完成两条指定分支的真实 Git 合并，并形成双父提交。没有推送、创建 PR、部署服务或访问内网资源。

| 项目 | 值 |
| --- | --- |
| 工作树 | `/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork` |
| 分支 | `codex/devclaw-bot-integration` |
| 合并提交 | `4d778d28972eb9a60fe792bd0a9c5450f4c5f0ee` |
| 第一父提交：IM 主基线 | `929c62e1f47406ae4ebb45455a405e1601eba58c`，`codex/chatx-unified-bot-design` |
| 第二父提交：需求/原型 | `2e1f65e693b5675b779522fd60b57fe077140a06`，`origin/feature_design_qyang` |
| 合并基点 | `9577a7bf8be16df46de60f82764f26868cc4f378` |

已定向获取上述两个远端分支；获取时远端 SHA 与本次采用的 SHA 一致。没有合并 `feature_design_qyang2`、默认分支或其他未讨论分支。没有移动、重置原有工作树，也没有覆盖 d12a 中此前的研究文档。

本次是“代码基础整合 + 开发计划”，不是 DevClaw Bot 已实现。下一步见 [开发落地计划](devclaw-bot-implementation-plan.md)。

## 二、冲突处理

Git 报告 9 个冲突文件，均已解决并提交；同时检查了自动合并导致的语义冲突。

| 文件 | 处理原则 |
| --- | --- |
| `src/main/agent/runtime.ts` | 同时保留主分支的 Skills 动态刷新与需求模式的 allowlist 后端，避免旧检查点恢复失效技能 |
| `src/main/ipc/agent.ts` | 保留统一执行入口、IM 交互等待及 foreground tool policy；合并 IM 与需求模式系统约束，避免 spread 覆盖提示 |
| `src/renderer/src/App.tsx` | 接入需求/原型入口；保留设置覆盖层、自动化/市场、项目模式与路由隔离；模式标签纳入延迟渲染的原子路由 |
| `src/renderer/src/components/chat/ChatContainer.tsx` | 保留主分支命令行为，同时限制需求模式中的相关提交入口 |
| `src/renderer/src/components/sidebar/ThreadSidebar.tsx` | 保留主分支侧栏实现及其新路由/状态逻辑；需求入口使用自己的新增侧栏组件 |
| `src/renderer/src/components/tabs/FileViewer.tsx` | 接入原型标注包装组件，保留受限的本地依赖读取 |
| `src/renderer/src/components/chat/previews/HtmlPreview.tsx` | 默认交互预览；显式进入静态标注，再返回交互预览，不混合两种权限 |
| `src/renderer/src/lib/html-srcdoc.ts` | 主分支交互构建器保留；静态构建器拆出独立文件并提供兼容导出 |
| `src/renderer/src/lib/store.ts` | 保留设置覆盖层语义，新增设计模式状态，补齐切到市场/自动化时清理设计状态 |

另恢复了 `useBrowserViewLifecycle.ts` 被自动合并丢失的 `overlayThreadId` 条件：浏览器覆盖层必须有关联任务，不能只检查当前模块名称。

### HTML 预览的安全取舍

新增 `StaticHtmlPreview.tsx` 与 `static-html-srcdoc.ts`，明确区分：

- 交互预览：`sandbox="allow-scripts"`，运行生成页面的脚本，保持 opaque origin，不能读取 App DOM/preload。
- 静态标注：移除脚本与主动内容，`sandbox="allow-same-origin"`，仅供父页面访问元素做标注；界面明确提示“页面脚本已暂停”。
- 切换文件时不显示旧文档构建结果；返回交互模式重新进入隔离 iframe。

没有将 `allow-scripts` 与 `allow-same-origin` 合并。静态标注不能完整还原仅由脚本生成的 DOM，且当前静态构建器只内联同级 CSS；这是明确限制，不能以放松安全隔离来弥补。后续如需动态页面完整标注，应另行设计受控 DOM 快照方案。

## 三、原主分支历史测试断言

初跑出现两处失败，已在未修改的 `929c62e1` 主基线工作树复现，并核对实际代码行为后更新测试：

1. `desktop-agent-invoke-characterization.spec.ts` 仍查找 `const harnessAgentContext = ...`，但主分支已经变为 `let` 声明后在受控块内赋值。更新定位标记，保留初始化顺序校验，不修改业务逻辑迎合断言。
2. `im-local-zhaohu-journey.spec.ts` 仍把远程目标名和回执都当作普通 Thread 标题。主分支已经使用特性别名及结构化“项目模式会话返回”。更新目标别名、项目回执和会话列表断言，继续检查底层 Thread 初始标题、特性上下文和非当前任务标记。

没有删掉失败用例，也没有跳过后续套件。新增 `bot-mode-integration.test.ts` 及浏览器安全回归，并扩展路由/设置测试，覆盖本次整合边界。

## 四、验证结果

执行环境为 macOS，本轮使用 Node **22.22.2**，符合当前仓库 `>=18 <24` 的引擎约束。系统 Node 25 未用于本轮测试。

| 验证 | 结果 |
| --- | --- |
| 主进程 TypeScript：`tsconfig.node.json` | 通过 |
| 前端 TypeScript：`tsconfig.web.json` | 通过 |
| `npm run build` | 主进程、preload、renderer 构建通过；仍有静态/动态导入的分块提示 |
| `test:im-v1` 对应脚本 | 19 / 19 通过，含模拟招乎用户旅程 |
| `test:desktop-agent-baseline` 对应脚本 | 7 / 7 通过 |
| 需求/原型专项 tsx 脚本 | 5 / 5 通过 |
| 选定 Vitest 套件 | 10 个文件、55 项测试通过 |
| `tests/html-preview-browser.spec.mjs` | 13 项无头浏览器回归通过，含新增静态标注隔离与切换用例 |
| 本次源码/测试/脚本与包配置差异检查 | `git diff --cached --check` 通过；无剩余 Git 冲突 |

为避免串行 npm 脚本遇到失败即停止而漏跑后续，最终按 package.json 声明逐个执行了 IM 与桌面套件，所有脚本均返回 0。

5 个专项脚本为：

```text
tests/requirement-mode-skills.spec.ts
tests/requirement-manifest-loading.spec.ts
tests/requirement-history-filter.spec.ts
tests/requirement-store.spec.ts
tests/design-draw-note-binding.spec.ts
```

10 个 Vitest 文件为：

```text
src/main/ipc/requirements.test.ts
src/shared/visual-anchor.test.ts
src/shared/visual-context-builder.test.ts
src/shared/visual-edit-store.test.ts
src/shared/visual-submit-guards.test.ts
src/shared/chat-scroll.test.ts
src/shared/bot-mode-integration.test.ts
src/renderer/src/components/tabs/file-preview-isolation.test.ts
src/renderer/src/app-route-isolation.test.ts
src/renderer/src/lib/app-store-settings-overlay.test.ts
```

### 验证边界

- 未运行全仓所有测试或 Electron 完整用户界面 E2E；源码结构断言不等同于真实多人操作验证。
- 未调用真实模型、招乎、需求发布平台、内部 AutoBizDevOps 后端或 S3/MySQL/ES。
- 未验证 Linux/Windows、安装包签名、发行打包、跨节点恢复和生产性能。
- 依赖从同一主基线的已有 `node_modules` 复制到新工作树；合并后的 lockfile 与主基线相同。未重新执行干净环境 `npm ci`，这应列入 CI 的后续复现步骤。
- 测试中存在 Node SQLite / LangSmith 实验性提示，不影响本次退出码；不据此宣称依赖已通过生产稳定性评估。

## 五、合并体量与保留策略

合并相对第一父提交共改变 **3,916 个文件，956,225 行新增、198 行删除**。其中：

| 范围 | 变更文件数 |
| --- | ---: |
| `src/` | 89 |
| `tests/` | 10 |
| `playwright-main/` | 3,221 |
| `.playwright-mcp/` | 315 |
| 其他文档、资源、配置等 | 281 |

巨大差异主要来自来源分支已跟踪的辅助代码/历史材料，不能把它等同于本次实现了近百万行业务代码。`.gitignore` 不会让已跟踪文件自动退出合并。

本次按用户要求完整合并，未擅自删除或改写来源历史。当前 Electron 打包 `files` 白名单未包含上述两个大目录，但没有实际运行发行打包；正式发布前仍需做产物、来源、许可证和敏感信息检查。

## 六、进入试点前的硬门禁

**最优先是需求发布 Token 的处理。** 来源分支保留了将真实 Token 拼入对话的行为，本次未借合并擅自重写发布系统；该问题已列入落地计划 F02，必须先改为凭据引用与受控工具，再接真实账号和团队共享。

其次是需求到原型的 selection 消费、正式成果版本/审批、多用户授权与任务交接。这些是下一阶段开发内容，不能因本次构建通过而视为可用。

建议以本次合并提交为开发起点，先完成安全基线与契约，再实现“共享任务 + 单伙伴 + 本地 Runtime + 可编辑 PRD”的薄切片。
