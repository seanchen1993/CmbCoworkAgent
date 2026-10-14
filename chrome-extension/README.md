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

首次连接尚未验证成功时，扩展按 1 秒、3 秒、10 秒各重试一次；仍然失败才使用
名为 `cmb-native-host-reconnect` 的单个 alarm 请求每分钟重试一次。分钟重试失败
不会重新开始上述三次重试，也不会反复重建同名 alarm。桌面应用通过当前有效连接
报告协议版本 1 且连接成功后，扩展立即取消分钟重试。

已经验证成功过的会话意外断开时，扩展只使用剩余的三次重试预算；耗尽后停止，
等待用户点击“重新连接”，不会转入分钟重试。连接稳定 30 秒才恢复三次重试预算，
短暂连接不会补充预算。点击“重新连接”会清除旧 timer/alarm 并恢复预算，但不会
清除本次 Service Worker 会话的成功记录，所以之后再次耗尽仍会停止。打开扩展
弹窗只会查看状态，不会在轮询过程中反复启动 Native Host。

Service Worker 重新启动时会先检查已有 alarm；若存在，会等待分钟事件，不会额外
启动一轮重试。Chrome 可能延迟 alarm 事件，尤其在设备休眠时，因此“每分钟”是
调度请求，不保证精确时间。Chrome 150 之前的 alarm 在浏览器重新启动等情况下可能
被清除；此时新的 Service Worker 会按初次连接流程恢复，不能保证跨浏览器会话永续。
扩展兼容 Chrome 94 的 callback API，并兼容 Chrome 111 及以上 `alarms.create` 的
Promise；未使用 Chrome 150 才提供的 `persistAcrossSessions` 字段。

该扩展只导入 Cookie，不导入 Chrome 保存的密码、历史记录或书签。

## 源码恢复与打包

本目录完整 10 个文件（README、manifest、popup 的 HTML/CSS/JS、Service Worker 和
4 个图标）恢复自 Git 对象 `c660e8f93200f291400c419e86e754d1638900d3` 中的
`chrome-extension/`。该对象用于逐文件恢复资产，不表示它是当前开发 HEAD 的祖先。
恢复时各文件的 Git blob SHA1 和字节数均已核对；随后仅更新本 README、扩展版本
0.1.3、`alarms` 权限和连接恢复逻辑。公钥、派生扩展 ID、Native Host 名称、协议和
Cookie 授权/导出范围保持项目约定。

在仓库根目录执行：

```powershell
node scripts/package-chrome-extension.mjs output/chrome-extension-0.1.3
```

Windows 下目录和文件名可使用不同大小写，但请保留小写 `.mjs` 扩展名；Node 的
模块格式加载器不支持 `.MJS`，这发生在脚本入口执行之前。

请使用一个尚不存在的 `output` 子目录。脚本不会覆盖旧目录，也不接受目录或文件
链接。生成的 `chrome-extension.zip` 根层直接包含 `manifest.json`、popup 文件、
Service Worker、README 和 `icons/`，共 10 个文件；旁边的
`chrome-extension-package.json` 记录恢复来源、文件字节数、SHA-256 和恢复后变更，
`SHA256SUMS.txt` 记录 ZIP 的 SHA-256。脚本只生成包，不自动安装扩展。

alarm 行为以 [Chrome 官方 alarms 文档](https://developer.chrome.com/docs/extensions/reference/api/alarms)
为依据（2026-10-04 更新）。
