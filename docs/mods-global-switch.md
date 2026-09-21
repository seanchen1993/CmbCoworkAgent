# Mods 应用级总开关

开发分支现在增加了 `modsGlobalEnabled` 应用设置，默认值为 `false`。它位于 Function Mods 页面顶部，名称为“启用 Mods 功能（应用级）”。

关闭时：

- 旧版 Mods 和 Function Mods 都不会拦截工具、注册命令、处理 turn 生命周期或打开 Mods 面板；
- 已有项目级启用状态、授权记录和插件文件保留，不做删除；
- 插件安装与更新、Skills、MCP 配置、普通聊天、工作流和其他主工程能力继续走原有路径；
- 已经加载的 Mods runtime 会被停止，正在等待的 Mods 操作会失效，防止开关关闭后继续执行。

打开时：

- 现有项目级开关和授权记录继续生效；
- 需要使用 Mods 的项目还必须单独打开“启用项目 Mods”；
- 重新打开后会按已有 digest 和授权状态重新加载，不会自动扩大权限。

验证方式：

1. 新的隔离用户目录启动应用，进入“自定义 → 插件”。总开关应为关闭。
2. 开关关闭时，普通项目消息、Skills 和 MCP 流程照常工作；Mods 命令不会出现在当前会话命令列表中。
3. 打开总开关，再打开项目级 Mods 开关，原有授权的 Mods 恢复运行。
4. 运行中的 Mods 被关闭后，旧 session、工具目录和待执行动作会被清理；重新打开后创建新的运行上下文。

实现位置：

- 设置读写：`src/main/storage.ts`
- 运行时门控和清理：`src/main/mods/manager.ts`、`src/main/mods/v2/manager.ts`
- IPC 与权限边界：`src/main/ipc/mods.ts`
- UI：`src/renderer/src/components/customize/ModsPanel.tsx`
- 回归测试：`src/main/mods/manager.test.ts`、`tests/mods-e2e.spec.ts`

