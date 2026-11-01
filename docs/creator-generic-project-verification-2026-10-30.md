# 通用项目插件创作：本轮验证

基线：`codex/mods-v2`，HEAD `7d15bfd97` 加本轮未提交修改，应用版本保持 `2.0.0`。开发前已 fetch 并确认 `origin/uat-without-mods` 是当前 HEAD 的祖先。

最终更新：2026-10-31。功能实现及两位 agent 的通用性复核完成；当前候选的定向验收使用隔离 Node **22.23.4** / npm **10.9.9**，符合 `.nvmrc`。此前默认终端 Node 24 的结果单独记录，不混为同一次全量通过。

## 方案与评审

- 方案评审 A：架构、源码与版本边界，通过后开始实现。
- 方案评审 B：用户流程、工作量与可验收性，通过后开始实现。
- 实现后评审 A：交叉评审 UI、提示指引、参考脚手架测试与使用文档，通过，无阻断项。
- 实现后评审 B：交叉评审 Host、IPC、preload 与提示指引，通过，无阻断项。
- 10 月 31 日按用户要求再次复核：没有固定 AutoBiz 阶段、默认研发流程或新专用执行器。两位均通过；新增通用职责指引、末尾阶段删除回归和大小限制诊断也已交叉复审。

没有新增 AutoBiz 专用平台逻辑。实现复用原生组合和 ProjectAuthoringSessions；接口按实际 stageId 解析作者文件，只替换正文，保留原始 frontmatter、资源、检查和原试用版本。

## 已完成检查

| 检查 | 本轮结果 | 证明范围 |
| --- | --- | --- |
| Node 22：9 个核心 Vitest 文件 | 92 项通过 | 阶段投影与保存、严格 IPC、preload、原生派生、续作、交付和候选失效、创作指引 |
| Node 22：6 个组合与契约 Vitest 文件 | 99 项通过 | 通用精确补丁、独立供应商流程、公开依赖、编译器身份绑定、源码集合安装入口；含三处旧断言修正的复验 |
| Node 22：项目作者补丁文件 | 8 项通过 | 非 AutoBiz 模板追加、替换、移除末尾阶段后编译，检查/资源保留，旧版本隔离；合计 **16 文件 199 项** |
| Node 22：完整 Node/Web typecheck | 通过 | 本轮代码类型检查 |
| Node 22：19 个变更 TypeScript 文件 ESLint | 0 错误，仍有格式告警 | 包含原大文件格式警告；未对无关旧文件做批量格式化；最后 UI 微修两文件单独 lint 无告警 |
| 新组件及浏览器测试单独 lint | 0 错误、0 警告 | 新增 UI 与浏览器脚本 |
| Node 22：`npm run test:creator-flow` | 19 套脚本全部通过 | 创造者入口、原生配置/授权、试用、编辑、交付、恢复及结果评审；没有跳过原脚本 |
| 阶段编辑浏览器回归（最终微修后另跑） | 通过 | React StrictMode、保存、冲突保留、切换取消、卸载恢复、账号隔离、迟到响应、共享文件只读、缓存失败、72KiB 正文被 Host 拒绝后完整保留与 375px 布局 |
| 完整创作面板浏览器场景 | 通过 | 没有 Mod 草稿/试用时，原生作者草稿使编辑工作区可见；后台新增与重挂均可进入 |
| `git diff --check`（本轮路径） | 通过 | 无新增空白错误 |

定向 Vitest 文件为：`project-reference-scaffolds`、`mod-authoring-runtime`、`project-stage-prompts`、`mods-development`、preload `development`、`project-from-plugin`、`project-continuous-creation`、`creator-project-delivery`、`creator-project-delivery-observation`。

补充文件为：`project-source-patch`、`native-composition-dependencies`、`business-workflow-transform-independent.integration`、`project-dependency-impact`、`native-composition`、`creator-source-set.integration` 和 `project-authoring-patch`。阶段删除的正例验证移除新增的末尾阶段，不把它夸大为任意图变换或所有旧插件自动迁移。

AutoBiz Lean 与 native-modular 参考回归实际编译作者源及提供器描述，派生、修改、重新编译、将新包再次派生并恢复持久化草稿；原安装源码与其他资源保持不变。二次派生补充后单文件 2 项再次通过，并由评审 A 确认。测试不伪造安装授权、模型运行或用户业务交付。

浏览器截图：

- [完整面板，尚未试用即可编辑](../output/project-stage-prompts-browser/1793434851525/04-native-draft-before-trial.png)
- [保存与交给创造者](../output/project-stage-prompts-browser/1793434851525/01-saved-stage-prompt.png)
- [恢复旧版未保存文字](../output/project-stage-prompts-browser/1793434851525/02-restored-stale-edit.png)
- [窄屏及缓存失败提示](../output/project-stage-prompts-browser/1793434851525/03-mobile-cache-failure.png)

## 整仓回归

10 月 30 日执行的 `npm test` 使用默认 Node 24.14.0；续作时原进程已不存在，日志停在 Vitest 中途，没有完成汇总。保留的部分日志有 **701 个通过套件、13 项失败**，不是最终总数；后续串联脚本未由该次命令执行完毕。日志位于本机临时目录 `creator-generic-full-test.log`。本轮不能声明整仓全绿或支持环境的完整整仓验收完成。

三项属于与当前契约不一致的旧断言，已保持严格负例并修正，两位 agent 均复审，通过上述 Node 22 回归验证：

- 源码集合导入应包含现有五阶段中的 `baseline`。
- 删除已接受的上游产物应报告 `PROJECT_HOST_EVIDENCE_STALE`。
- 提供器身份冲突需同时核对外层契约错误和内部完整身份冲突诊断。

其余 10 项在 Node 22、单 worker、原有超时门限下按名称筛选复验：**5 项通过、5 项失败**（127 个未选择用例未运行）。此前四项超时和 SQLite 测试准备失败均在该次复验通过；不能据此倒写第一次结果。仍失败的模块及实际诊断如下，本轮未修改这些模块或降低其检查：

| 文件 | 失败数 | 观察到的问题 |
| --- | --- | --- |
| `platform-workbench.integration.test.ts` | 2 | 既有 workbench/edit-reminder 示例的 SDK 静态审查返回 `MODS_SDK_UNVERIFIED`，存在未验证闭包捕获；不是阶段编辑器的类型错误 |
| `snapshot-reference-audit.test.ts` | 2 | 审计不完整，返回 `SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN` |
| `derivation-source.test.ts` | 1 | DFS 错误与后续元数据错误时序用例中，预期活动读取句柄大于零，实际为零 |

这些遗留问题的根因修复未纳入本轮。原生派生正常路径的通过不代表所有异常源码读取路径均已验收。对失败项的复验日志为 `creator-generic-node22-baseline-recheck.log`；本轮正常验证日志为 `creator-generic-node22-focused.log`、`creator-generic-node22-composition.log`、`creator-generic-node22-typecheck.log`、`creator-generic-node22-browser.log` 和 `creator-generic-node22-eslint.log`，均在本机临时目录。

## 验收边界

浏览器测试使用真实组件与模拟 IPC；Host 测试使用真实作者会话、持久化、编译器和交付逻辑。两者均不能代替当前候选在 Electron 中由真实模型完成新建/派生、试用及保存插件的全链路。

本轮未运行新的真实模型业务试用，未修改应用版本，未构建打包、提交、推送或触发 Actions。既有输出删除及无关本地报告保留原样。

## 后续状态（2026-10-31 新任务）

用户继续授权修复上述 5 项并进行真实模型验收后，相关根因已修复；已完成的真实链路、仍在验收的完整 AutoBiz、D 盘模板及全量测试情况单独记录在 [续作验证](creator-live-followup-2026-10-31.md)。本页此前“未运行”“仍失败”等文字描述的是前轮结束时的历史状态。新任务生成了本地测试构建，仍未打安装包、提交或推送。
