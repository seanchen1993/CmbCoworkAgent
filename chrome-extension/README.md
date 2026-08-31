# CmbCoworkAgent Browser Importer

该扩展用于 Windows 版 CmbCoworkAgent 导入当前 Chrome Profile 的 Cookie。Cookie 由
Chrome 扩展 API 解密后，通过 Native Messaging 发送给本机 CmbCoworkAgent；它不会复制或
直接读取 Chrome 的 `Cookies` 数据库文件。

## 安装

1. 启动 Windows 打包版 CmbCoworkAgent 并保持运行。
2. 在 Chrome 打开 `chrome://extensions/`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本文件所在目录。
4. 打开扩展弹窗，授权网站访问权限。
   Chrome 102 及以上会直接弹出权限确认；Chrome 94 这类较老版本请按弹窗提示到扩展详情页把“站点访问”设为“在所有网站上”。
5. 回到 CmbCoworkAgent，重新执行“导入浏览器信息”。

扩展 ID 必须是 `lnfdbegfbhhlfimnojpalnkmhkgfahin`。如果 Chrome 显示其他 ID，请勿继续，
应改用带有正确签名密钥的扩展包。

## 排障

- 扩展弹窗日志：打开 popup 后右键弹窗，选择“检查”，搜索前缀 `[CmbBrowserExtension][Popup]`。
- Service Worker 日志：在 `chrome://extensions/` 打开该扩展的 `Service worker` 检查页，搜索前缀 `[CmbBrowserExtension][ServiceWorker]`。
- 显示“Native Host 已找到，但启动或通信失败”：重启桌面应用，再点击“重新连接”。
- 显示“CmbCoworkAgent 未连接”：确认桌面应用正在运行，然后点击“重新连接”。
- 显示未授权：在扩展弹窗授权网站访问权限后重试。
- Chrome 94 点击授权按钮没有弹框：这是旧版 Chrome 不支持该运行时授权弹窗。请按扩展弹窗提示，到“管理扩展程序”里把本站点访问改成“在所有网站上”。
- Native Host 未注册：退出并重新启动 Windows 打包版 CmbCoworkAgent。开发模式不注册 Host。
- 更新应用后连接失败：重启桌面应用，让它修复 Native Host 注册，再点击“重新连接”。

扩展首次连接失败后不会在后台持续重试。已经成功连接的会话意外断开时，扩展只会按
1 秒、3 秒、10 秒各重试一次；仍然失败后会停止，直到用户点击“重新连接”。打开扩展
弹窗只会查看状态，不会在轮询过程中反复启动 Native Host。

该扩展只导入 Cookie，不导入 Chrome 保存的密码、历史记录或书签。
