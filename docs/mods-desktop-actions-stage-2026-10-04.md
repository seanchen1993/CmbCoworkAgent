# 选中文字、复制与面板状态的迭代结果

这轮已经把三个接口接到 DevClaw 的实际聊天和右侧栏。模组可以读取用户在当前聊天亲自选中的文字，处理后请求复制，也可以查询自己的面板是否正在显示。两个独立插件可以分别负责选择面板和复制前加标题，DIY 时可以自由选用其中一个或同时组合。

## 如何体验

参考 [选择面板说明](../examples/mods-desktop-selection/README.md)。安装 `output/mods-desktop-selection.zip`，批准后选择它的组件，在对话输入 `/selection-board` 打开右侧面板。选中聊天中的文字，再点面板中的“复制所选文字”。安装并组合 `output/mods-copy-prefix.zip` 后，复制前会自动加上“检视摘录”标题。文字是否成功复制以面板实际回执为准。

## 已验证的行为

- 用户点击按钮后仍能读取刚选中的文字；新选择替换旧选择，Escape 和任务收尾清理自己的旧选择。
- 单条消息或工具行保留实际编号；跨行选择不冒充编号。配置区域、隐藏内容和其他会话不可读取。
- 切会话、关闭、取消、撤权和重载后，旧请求不能借用新窗口或新任务。
- 复制处理可以组合、改写或拒绝；组件不能只返回“成功”就伪造系统已经复制。
- 面板状态来自真实布局，查询不重绘面板，也不调用模型。
- Function Mods 宿主版本提升到 v71，新增能力须重新批准；原 Plugin 与常规聊天的入口没有改变。

## 验证范围与限制

两位独立评审最终通过。受控并发的回归覆盖 334 个文件、2844 项测试；另外真实浏览器 21 个场景通过，实际 Electron 桌面阶段 9 项通过，邻接输入编辑和连续任务阶段各 10、8 项通过。Node 和 Web 类型检查通过，新增生产代码及测试 lint 通过。较大范围测试明确排除了已有主题颜色策略失败，不能据此宣称全工程没有历史测试问题。

24 次实际模组面板查询包含主进程、渲染层往返，中位数 14 毫秒，95% 分位 15 毫秒；没有额外重绘。这是本地面板查询耗时，不代表模型或网络耗时。

本机 Windows `OpenClipboard` 实验返回错误 5，Electron 和独立系统调用都无法写入。因此已验证真实失败返回 `no-clipboard`，**尚未验证本机原生成功复制**。不展示假成功，不记录原剪贴板内容，也不宣称无法读取的原剪贴板已经恢复。Electron 39 对空串不能区分读取成功与读取被拒绝，当前空串复制明确失败；格式存在不能充当成功证明。此项列为明确兼容边界，不能说已与官方任意字符串复制完全一致。

证据在 `output/mods-desktop-controlled-broad-final.log`、`output/mods-desktop-browser-final-confirmed.log`、`output/mods-desktop-electron-final.log`、`output/mods-desktop-typecheck-confirmed.log`、`output/mods-desktop-final-lint.log` 和 `output/mods-validation/e2e-desktop-actions/`。截图见该目录的 `desktop-selection-copy.png`。

整体对齐工作继续，下一轮方案见 [任务后的用量通知](mods-session-measure-design-2026-10-04.md)。这些结果只确认本阶段，不代表所有 Claude Mods 能力已完成。
