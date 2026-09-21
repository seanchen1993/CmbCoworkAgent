# Mods 应用级总开关

开发分支现在增加了 `modsGlobalEnabled` 应用设置，默认值为 `false`。它位于 Function Mods 页面顶部，名称为“启用 Mods 功能（应用级）”。

设置入口：

- “自定义 → Function Mods”默认置灰，输入管理口令 `admin123456` 后解锁。
- 解锁状态只保存在主进程内存中，并绑定当前应用窗口；重启后重新锁定，不保存输入的口令。
- 解锁不会自动开启运行开关，也不会改写已有的开关状态。开启、项目配置、授权和安装示范 Mods 均有主进程校验。
- 此固定口令用于限制实验功能的误操作，不是企业身份认证或本机管理员的安全隔离。
- 未解锁时不挂载实际设置内容，不读取项目授权清单或审计列表。

卸载：

- 解锁后，在“已安装的 Mods 插件”点击“卸载”，在确认框中确认。
- 不需要打开项目或开启 Mods 即可卸载；取消确认不会修改插件。
- 复用现有插件卸载路径，移除整个来源插件的文件及注册信息，包括其 Skills、MCP 和 Hooks；其他插件保留。
- 删除注册信息后立即使相关 Mods 运行会话和旧命令失效，再等待 MCP 刷新，避免刷新期间继续执行已卸载的模块。
- 审计、授权和持久状态记录保留；同一源码重装后可能复用既有授权，卸载不等于清空所有历史数据。

关闭时：

- 旧版 Mods 和 Function Mods 都不会拦截工具、注册命令、处理 turn 生命周期或打开 Mods 面板；
- 已有项目级启用状态、授权记录和插件文件保留，不做删除；
- 总开关目标是让插件安装与更新、Skills、MCP、普通聊天和工作流绕过 Mods 拦截；这不等于撤销之前对共享代码的修改；
- 已经加载的 Mods runtime 会被停止，正在等待的 Mods 操作会失效，防止开关关闭后继续执行。

打开时：

- 现有项目级开关和授权记录继续生效；
- 需要使用 Mods 的项目还必须单独打开“启用项目 Mods”；
- 重新打开后会按已有 digest 和授权状态重新加载，不会自动扩大权限。

验证方式：

1. 新的隔离用户目录启动应用，进入“自定义 → Function Mods”，输入口令解锁。总开关应为关闭。
2. 开关关闭时，普通项目消息、Skills 和 MCP 流程照常工作；Mods 命令不会出现在当前会话命令列表中。
3. 打开总开关，再打开项目级 Mods 开关，原有授权的 Mods 恢复运行。
4. 运行中的 Mods 被关闭后，旧 session、工具目录和待执行动作会被清理；重新打开后创建新的运行上下文。

限制：关闭时仍存在 Mods 代码加载、控制数据库初始化、IPC 和部分主链路包装。尚未完成与引入 Mods 前版本的全功能、全性能对照，不应据此声称“零影响”或 UAT 验收完成。

实现位置：

- 设置读写：`src/main/storage.ts`
- 运行时门控和清理：`src/main/mods/manager.ts`、`src/main/mods/v2/manager.ts`
- IPC 与权限边界：`src/main/ipc/mods.ts`
- UI：`src/renderer/src/components/customize/ModsPanel.tsx`
- 回归测试：`src/main/mods/manager.test.ts`、`tests/mods-e2e.spec.ts`
- 设置口令回归：`src/main/mods/settings-access.test.ts`
- 生产 Electron 设置与卸载回归：`npm run test:mods:settings:e2e`（隔离用户目录，无需外部模型）
