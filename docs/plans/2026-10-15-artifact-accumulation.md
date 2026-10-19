# 特性产物同步实施计划

目标：插件声明 artifact_sync 后，在特性详情页增加“发起产物同步”。新会话与手动新增会话使用相同流程，仅 nextAction 不同。

实现：TypeScript、React、现有 Harness 配置读取和特性会话工具。复用现有占位符替换，不增加持久化字段、会话分类或 IPC 接口。

1. 修改 catalog-reader.ts，保留 artifact_sync 的 sync_type 和 nextAction；补充配置投影测试。
2. 修改 service.ts 和 harness-board-types.ts，在特性详情中返回 artifactAccumulation，替换项目编号、特性标识和 token 等占位符；补充服务测试。
3. 新增 ArtifactAccumulationButton.tsx，在 HarnessBoardView.tsx 指定位置接入；与新增会话共用处理函数和创建中状态，仅覆盖 nextAction。
4. 运行相关 Vitest 测试、类型检查和修改文件的 ESLint。检查最终差异，不使用格式自动修复、浏览器自动化或截图。

验收：缺失或不支持的配置不显示入口；有效配置创建当前特性会话，沿用当前工作目录、上下文、权限和招乎接入；消息只预填，不自动发送。

产物同步入口显式设置 agentMode 为 normal、subagentsEnabled 为 true，以 multi 模式初始化。普通新增会话仍由插件决定初始模式；用户后续可以手动切换模式。
