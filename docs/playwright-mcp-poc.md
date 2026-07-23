# Playwright MCP 内置浏览器 PoC

这个 PoC 让 Playwright MCP 通过标准 CDP 控制 Electron `WebContentsView`。现有 Browser
Plugin 和 adapter 不会被删除，正常执行 `npm run dev` 时行为保持不变。

## 启动

先完全退出所有正在运行的 CMBDevClaw 实例。应用启用了单实例锁；旧实例未退出时，新启动的
PoC 实例会退出，CDP 端口也不会生效。

```bash
npm run dev:playwright-mcp-poc
```

默认 CDP endpoint 是 `http://127.0.0.1:9222`。可以通过环境变量覆盖端口：

```bash
CMB_BROWSER_CDP_PORT=9333 npm run dev:playwright-mcp-poc
```

启动后可以检查 endpoint：

```bash
curl http://127.0.0.1:9222/json/list
```

## 配置 MCP

在「自定义 > MCP 连接器」中导入以下 JSON：

```json
{
  "mcpServers": {
    "Playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--cdp-endpoint=http://127.0.0.1:9222"],
      "lazyLoad": false
    }
  }
}
```

PoC 期间需要同时：

1. 禁用 Browser Plugin，确保 Agent 不再获得 `mcp__node_repl__js`。
2. 禁用原有的 `browser-use` MCP 连接器，确保 Agent 不会调用 `mcp__browserUse__*`。
3. 启用上面的 `Playwright` MCP 连接器。

调用 `mcp__playwright__browser_*` 工具前，必须先手动打开当前任务右侧“浏览器”Tab，并等待
内置浏览器显示。若未打开，工具会提示先打开“浏览器”Tab 后重试，不会自动创建
`WebContentsView` 或切换面板。

运行自检：

```bash
npm run check:playwright-mcp-poc
```

自检必须同时显示 CDP endpoint、Playwright MCP connector 和 WebContents targets 正常，并显示
Browser Use MCP connector 已禁用。

## 验证

在任务输入框发送：

```text
使用 Playwright MCP 控制内置浏览器 tab，不要创建新 tab，也不要操作应用主页面。
打开 https://example.com，告诉我页面标题。
```

预期工具调用包括：

```text
mcp__playwright__browser_tabs
mcp__playwright__browser_navigate
mcp__playwright__browser_snapshot
```

不应出现 `mcp__node_repl__js`。页面导航应同时显示在右侧 Browser 面板中。
也不应出现 `mcp__browserUse__*`；出现该前缀表示调用了错误的 MCP 连接器。

## 回退

停止 PoC 进程后使用 `npm run dev` 正常启动，并重新启用 Browser Plugin。未设置
`CMB_BROWSER_CDP_PORT` 时，应用不会开放 CDP endpoint。
