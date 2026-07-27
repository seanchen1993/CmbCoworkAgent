# 浏览器集成

该项目是基于 Electron 的 AI 开发助手桌面应用，浏览器相关代码按功能分为三个模块：**核心模块（core）**、**CDP 桥接（cdp）**、**Chrome 数据导入（chrome）**。

代码目录：`src/main/browser/`

---

## 一、核心模块 (core/)

基于 Electron `WebContentsView` 的内嵌浏览器，渲染在应用右侧面板中。

### 1.1 文件结构

| 文件 | 职责 |
|------|------|
| `browser-service.ts`（~1177 行） | WebContentsView 生命周期管理、导航、截图、输入、Cookie 导入 |
| `browser-session-data.ts` | BrowserSessionCookie、BrowserSessionData 等会话数据类型 |
| `browser-service-registry.ts` | 全局单例管理 BrowserService 实例，供 Playwright MCP bridge 和主进程共享 |

### 1.2 关联文件

| 层次 | 文件 | 职责 |
|------|------|------|
| 类型定义 | `src/shared/browser-types.ts` | BrowserState、BrowserBounds、BrowserConsoleEntry 等类型 |
| IPC 桥接 | `src/main/ipc/browser.ts` | 注册 detach、navigate、captureScreenshot 等 11 个 handler |
| 渲染层 | `src/renderer/src/components/browser/BrowserPanel.tsx` | React 组件：地址栏、导航按钮、截图、控制台、全屏、导入 Cookie |

### 1.3 BrowserService 核心能力

- **attach / detach**: 全应用共用 `app-browser` 单一 WebContentsView；切换线程时复用页面，仅在关闭或应用重载时销毁
- **navigate**: URL 自动规范化（localhost、file://、相对路径 → 绝对路径）
- **goBack / goForward / reload / stop**: 标准浏览器导航
- **captureScreenshot**: 通过 `webContents.capturePage()` 截图，返回 base64 data URL
- **importProfileData**: 全局导入 Chrome Profile Cookie 到独立 partition
- **Console 收集**: 最多 200 条，每条 ≤4000 字符
- **权限控制**: 默认拒绝所有权限请求

### 1.4 安全配置

```ts
webPreferences: {
  partition: "persist:cmbdevclaw-browser-profile",
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
}
```

---

## 二、CDP 桥接 (cdp/)

### 2.1 文件结构

| 文件 | 职责 |
|------|------|
| `browser-cdp.ts` | CDP 端口配置与 Playwright MCP 连接器自动注册 |
| `playwright-mcp-bridge.ts` | Playwright MCP 工具与内置浏览器面板的同步桥接 |

### 2.2 CDP 端口配置

通过 `BrowserWelcomePanel` 中的手动配置卡片控制：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `enabled` | 关闭后不再暴露 CDP endpoint，也不会自动接管内置浏览器 | `true` |
| `port` | CDP 端口号 | `7777` |

启动时调用 `app.commandLine.appendSwitch("remote-debugging-port", port)` 开放 CDP endpoint。CDP 开启时，自动注册名为 `"In-app-browser"` 的 MCP 连接器：

```bash
npx -y @playwright/mcp@latest --cdp-endpoint=http://127.0.0.1:7777
```

CDP 连接器名和默认端口定义在 `browser-cdp.ts` 中：

该配置会持久化保存；由于 Electron 启动参数限制，保存后需要重启应用生效。

### 2.3 Playwright MCP 桥接

负责将 Playwright MCP 工具与内置浏览器面板同步：

- **shouldPreparePlaywrightInAppBrowser()**: 检测 MCP 工具是否为内置浏览器相关（provider 为 `inappbrowser` 或工具 ID 以 `mcp__inAppBrowser__` 开头）
- **preparePlaywrightInAppBrowser()**: 等待面板就绪（最多 1500ms，100ms 轮询），调用 `service.prepareTarget()`
- **autoSelectPlaywrightInAppBrowserTab()**: 解析 Playwright `browser_tabs` 输出，根据 URL/Title 自动匹配并 `select` 对应 tab

Session ID 固定为：`app-browser`。任意线程调用 Playwright MCP 工具都会复用这一浏览器目标。

### 2.4 使用方式

CDP 默认启用，无需额外配置。触发流程：

1. Agent 调用 Playwright MCP 工具（如 `mcp__inAppBrowser__browser_navigate`）
2. Bridge 检测到内置浏览器相关工具调用
3. 自动等待右侧"浏览器"面板就绪
4. 自动将 Playwright tab 与面板同步
5. 执行对应的浏览器操作

---

## 三、Chrome 数据导入 (chrome/)

从 Chrome 浏览器导入 Cookie 和会话数据到内置浏览器，支持两种导入链路。

### 3.1 文件结构

| 文件 | 职责 |
|------|------|
| `browser-profile-importer.ts` | 从 Chrome Profile 读取 Cookie 并导入到独立 partition |
| `browser-extension-cookie-importer.ts` | 处理 Chrome Extension 导出的 Cookie 数据 |
| `browser-cookie-bridge-server.ts` | TCP bridge server，接收来自 Chrome Extension 的 Cookie 数据 |
| `browser-cookie-bridge-paths.ts` | Cookie bridge 相关的文件路径配置 |
| `browser-native-messaging-host.ts` | Chrome Native Messaging Host 实现 |
| `browser-native-host-installer.ts` | Native Messaging Host 的安装与注册 |
| `browser-native-host-entry.ts` | Native Messaging Host 入口 |
| `native-messaging-framing.ts` | Native Messaging 协议帧编解码 |

### 3.2 导入链路

**链路一：Chrome Profile 直接读取**

1. 用户点击"导入 Cookie"按钮
2. `browser-profile-importer.ts` 直接读取本地 Chrome Profile 目录中的 Cookie 数据库
3. 将 Cookie 写入内置浏览器的独立 partition

**链路二：Chrome Extension + Native Messaging Host**

1. Chrome Extension 通过 Native Messaging 协议与 Native Host 通信
2. Native Host（`browser-native-messaging-host.ts`）接收 Extension 发送的 Cookie 数据
3. TCP bridge server（`browser-cookie-bridge-server.ts`）将数据转发到主进程
4. `browser-extension-cookie-importer.ts` 处理并导入 Cookie

### 3.3 关联类型定义

| 文件 | 职责 |
|------|------|
| `src/shared/browser-cookie-bridge.ts` | Cookie bridge 通信协议的类型定义 |

---

## 四、Preload API

通过 `window.api.browser` 暴露给渲染进程：

- `detach`, `setBounds`
- `navigate`, `goBack`, `goForward`, `reload`, `stop`
- `getState`, `captureScreenshot`, `clearConsole`
- `importProfileData`
- `disposeAllForRendererUnload`
- `onState`（状态事件订阅）
- `onPanelRequest`（主进程请求打开面板）

---

## 五、配置说明

- **内置浏览器面板**: 始终可用，通过右侧面板 "浏览器" Tab 打开
- **CDP 端口**: 由 `BrowserWelcomePanel` 手动配置，默认启用，端口 7777；保存后重启应用生效

---

## 总结

该项目实现了一套完整的浏览器自动化方案，代码按功能模块化组织：

1. **核心模块 (core/)** — WebContentsView 内嵌面板，支持导航、截图、输入、Console 收集、Cookie 导入，生产就绪
2. **CDP 桥接 (cdp/)** — 通过 `remote-debugging-port` 将 Electron CDP 暴露给 Playwright MCP，自动注册连接器、同步 tab 状态
3. **Chrome 导入 (chrome/)** — 从 Chrome Profile 直接读取或通过 Extension + Native Messaging Host 链路导入 Cookie 和会话数据
