# ARM64 macOS 打包

支持 Apple Silicon（M1/M2/M3/M4 等）和 macOS 13 及以上。Intel Mac / Universal 包尚未支持：内置 `resources/bin/darwin/rg` 是 ARM64 二进制。

## 本地构建

在 ARM64 Mac 上使用 Node.js 22 和 Xcode Command Line Tools：

```bash
npm ci --include=optional
npm run dist:mac
```

产物位于 `dist/`：

- `CMBDevClaw-<version>-macos-arm64.dmg`
- `CMBDevClaw-<version>-macos-arm64.zip`（包含完整 `.app`，保留执行权限）
- `mac-arm64/CMBDevClaw.app`

`dist:mac` 使用现有本地环境配置，并显式使用 ad-hoc 签名，无需 Apple 开发者证书。DMG 打开后将应用拖入 Applications；ZIP 解压后也可以将 `.app` 拖入 Applications。Ad-hoc 包首次打开时可能需要在“系统设置 → 隐私与安全性”中允许打开。面向其他用户分发时，使用下文的正式签名和公证流程。

无本地环境配置的离线测试包：

```bash
npm run dist:mac:smoke
npm run test:mac-package -- dist/mac-arm64/CMBDevClaw.app
```

`build:smoke` 为 main、preload 和 renderer 关闭 `.env*` 文件加载，不修改本地 `.env`。验证脚本使用临时用户目录、离线代理和假的 Claude CLI，不调用真实模型服务，也不依赖本机安装的 Claude CLI。

只验证已有构建产物或应用包：

```bash
npm run package:mac
npm run test:mac-package -- /path/to/CMBDevClaw.app --bundle-only
```

`package:mac` 只打包已有 `out/`。`--bundle-only` 验证架构、权限、资源、ripgrep，并使用包内 Electron 实际执行 node-pty、QuickJS/WASM、esbuild；省略该参数还会启动完整窗口并验证 preload、终端 IPC。对 UAT 包使用 `--bundle-only`，对离线 smoke 包运行完整验证。

## GitHub Actions

在 **Build Electron App → Run workflow** 中选择当前分支：

| 输入                          | 用途                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `platform=macos-arm64`        | 只运行独立的 macOS job，跳过 Windows/Linux                   |
| `macos_configuration=smoke`   | 离线测试构建，不需要环境解密密钥                             |
| `macos_configuration=uat`     | 复用 Windows/Linux 的 `.env` 解密流程和 `ENV_ENCRYPTION_KEY` |
| `sign_macos=false`            | Ad-hoc 签名测试包                                            |
| `sign_macos=true`             | Developer ID 正式签名、公证、装订票据                        |
| `macos_recipient_certificate` | 可选的 PEM RSA 公钥证书，沿用参考分支的 CMS 加密交付         |

原有 Windows/Linux 默认构建和 `v*` tag 触发规则保持不变；macOS 通过手动触发生成 Actions artifacts。

macOS job 在 `macos-15` ARM64 runner 上使用 Node.js 22，安装完整 optional dependencies，构建后挂载 DMG、提取应用并验证，再使用 `ditto` 生成便携 ZIP。ZIP 解压后重新校验；smoke 配置还会执行完整 UI/终端验证。两个 artifacts 的名称包含版本、配置和签名状态，下载后解开 Actions 外层 ZIP 即可得到 DMG 或便携 ZIP。

正式签名需要在仓库 Actions Secrets 配置：

| Secret                 | 内容                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `CSC_LINK`             | Developer ID Application 证书 `.p12` 的 base64 内容或 electron-builder 支持的证书地址 |
| `CSC_KEY_PASSWORD`     | `.p12` 密码                                                                           |
| `APPLE_API_KEY_BASE64` | App Store Connect API `.p8` 密钥的 base64 内容                                        |
| `APPLE_API_KEY_ID`     | API Key ID                                                                            |
| `APPLE_API_ISSUER`     | Issuer ID                                                                             |

正式签名模式缺少凭据、公证未通过或签名验证失败时构建会直接失败，不会上传冒充正式签名的测试包。公证通过后，对 DMG 和从中提取的 `.app` 分别装订票据，再生成便携 ZIP。

UAT 默认与 Windows/Linux 使用相同的交付方式：复用仓库已有的 `ENV_ENCRYPTION_KEY` 解密 `.env`，直接上传 DMG 和 ZIP，接收者证书可以留空。公开仓库携带客户端凭据不再单独阻止 macOS 构建。`ENV_ENCRYPTION_KEY` 保护的是仓库中的 `.env`，构建后内嵌在应用里的配置仍可能被产物接收者读取。

需要额外加密产物时，再填写 `macos_recipient_certificate`；它与 `.env` 解密密钥、Apple 签名凭据分别独立。填写后上传 `.dmg.cms` 和 `.zip.cms`。接收者可以使用 OpenSSL 3 解密：

```bash
openssl cms -decrypt -binary -inform DER \
  -in package.dmg.cms -out package.dmg \
  -recip recipient.crt -inkey recipient.key \
  -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256
```

## 验证范围

`npm run test:packaging` 检查 macOS helper 权限修复、原生模块实际加载路径、缺失或错误架构产物失败，以及 Windows/Linux 的打包后处理回归。

macOS 包检查保留当前分支的 Mods、skills、设计系统、设计模板和宠物资源，并验证 ARM64 esbuild、QuickJS WASM 和 PTY 的实际执行。主机上的冒烟验证不能替代最低 macOS 13 系统的实机兼容性验证。

macOS 的 PTY host 虽然从 `app.asar.unpacked` 启动，但通过 `createRequire` 从 `app.asar` 解析 `node-pty`，避免上游 helper 路径替换产生重复的 `.unpacked`。打包钩子在签名前修复 helper 执行权限，完整冒烟测试通过真实终端 IPC 验证这两项修复。
