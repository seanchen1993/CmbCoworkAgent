# Bot 浏览器：WPS 正文与登录态复用

Bot 私聊、群聊和独立任务通过自己的浏览器页面读取 WPS 在线文档，复用普通会话已有的 WPS OpenAPI 读取实现。不依赖 Feature 关联或插件绑定。

## WPS 文档

1. Bot 用 `bot_browser` 打开用户提供的文档链接。
2. 文档加载后，对该页面调用 `action: "read_wps_document"`。读取 `office-iframe` 中的正文，不依赖画布截图或可见 DOM。
3. 默认每次返回最多 20,000 字符，可用 `maxTextChars` 调整至最多 50,000。存在 `nextTextOffset` 时，将它作为下一次的 `textOffset`，直到没有后续偏移。
4. 读取仍受页面归属、人工接管和取消控制约束。文档加载失败或需要登录时会明确报错；Bot 可等待重试或请求接管。

返回包含 `pageId`、`url`、`text`、`totalChars`、`textOffset` 和可选的 `nextTextOffset`。普通会话原有 WPS 工具继续返回全文。

此能力读取 WPS 文字文档正文，不负责下载原始文件，也不新增表格、演示文稿或图片解析。

## 登录态

- 沿用内置浏览器配置中的「导入 Chrome 登录状态」，保存后重启应用生效。
- Bot 首次启动浏览器与普通会话共用本次应用会话的一次自动导入，不需要先打开普通会话浏览器。
- Windows 沿用 Chrome 扩展和 Native Host；Mac 沿用本地 Profile 导入。无需新增依赖或网关修改。
- 在内置浏览器中手动重新导入 Cookie，也会同步到已经启动的 Bot 浏览器。Bot 页面刷新或再次导航后使用新 Cookie；不会自动刷新正在操作的 Bot 页面。
- 仅复制 Cookie，Bot、群聊和任务的页面及接管状态保持独立。Cookie 值不作为工具结果返回，也不写入日志。
- 此方式复用 Cookie 登录态；依赖其他身份校验、过期登录或验证码的站点仍可能需要人工接管。关闭导入开关会停止后续导入，不会清空浏览器已保存的登录态。

## 本地验证

- 单测覆盖分段读取、超时、页面变化、所有权和接管、导入开关、自动导入合并、手动重试以及 Cookie 分批同步。
- `node scripts/run-bot-integration-e2e.mjs --browser` 使用隔离 Electron 配置，验证跨源 iframe 中的异步 WPS API、三个会话范围的正文完整性、模拟 Cookie 登录与手动更新，以及现有浏览器交互回归。
- 本地验证使用模拟文档及 Cookie，未连接内网招乎/WPS，也不读取真实 Chrome 凭据。真实站点登录兼容性需在内网确认。
