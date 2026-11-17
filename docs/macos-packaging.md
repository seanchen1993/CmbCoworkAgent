# ARM64 macOS 打包

支持 Apple Silicon（ARM64）和 macOS 13 及以上。Intel Mac / Universal 包尚未支持，内置 `resources/bin/darwin/rg` 为 ARM64 二进制。

## 统一构建流程

Windows、Linux、macOS 使用同一套环境配置，不区分 UAT/smoke。CI 均使用现有 `scripts/env-crypt.mjs` 和仓库 Secret `ENV_ENCRYPTION_KEY` 解密 `.env`，再执行 `npm run build`。

Windows/Linux 的原生依赖重建、打包、上传和 `v*` tag 触发规则保持原样。macOS 仅增加 ARM64 原生依赖处理、DMG/ZIP 打包和包内运行检查。

## 本地构建

在 ARM64 Mac 上使用 Node.js 22 和 Xcode Command Line Tools，准备与其他平台一致的本地环境配置后执行：

```bash
npm ci --include=optional
npm run dist:mac
```

产物位于 `dist/`：

- `CMBDevClaw-<version>-macos-arm64.dmg`
- `CMBDevClaw-<version>-macos-arm64.zip`（包含完整 `.app`，保留执行权限）
- `mac-arm64/CMBDevClaw.app`

已有 `out/` 时可使用 `npm run package:mac` 只打包。默认采用 ad-hoc 签名，无需 Apple 开发者证书；首次打开时可能需要在“系统设置 → 隐私与安全性”中允许打开。

## GitHub Actions

在 **Build Electron App → Run workflow** 中选择当前分支，页面只保留“打包平台”选项：

| 平台                        | 行为                                            |
| --------------------------- | ----------------------------------------------- |
| `windows-and-linux`（默认） | 按原有流程构建 Windows 和 Linux                 |
| `macos-arm64`               | 运行独立的 ARM64 macOS job，生成 DMG 和便携 ZIP |

每次触发不需要选择环境或填写密钥。macOS 复用仓库已有的 `ENV_ENCRYPTION_KEY`，也不再要求接收者证书或加密交付参数。与现有 Windows/Linux 一样，安装包中内嵌的环境配置可能被产物接收者读取。

macOS job 使用 `macos-15` ARM64 runner、Node.js 22 和完整 optional dependencies。构建后挂载 DMG、提取并验证应用，再使用 `ditto` 生成便携 ZIP，并重新解压校验。Actions artifacts 的名称包含版本和签名状态；下载并解开 Actions 外层 ZIP 后，即可取得 DMG 或便携 ZIP。

## 可选的正式签名和公证

默认不需要 Apple Secrets。需要正式签名时，由仓库管理员在 **Settings → Secrets and variables → Actions → Variables** 设置 `MACOS_SIGN_AND_NOTARIZE=true`，并在 Secrets 配置：

| Secret                 | 内容                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `CSC_LINK`             | Developer ID Application 证书 `.p12` 的 base64 内容或 electron-builder 支持的证书地址 |
| `CSC_KEY_PASSWORD`     | `.p12` 密码                                                                           |
| `APPLE_API_KEY_BASE64` | App Store Connect API `.p8` 密钥的 base64 内容                                        |
| `APPLE_API_KEY_ID`     | API Key ID                                                                            |
| `APPLE_API_ISSUER`     | Issuer ID                                                                             |

这是 macOS job 的仓库级配置，不会出现在手动触发页面，也不影响 Windows/Linux。正式签名模式缺少凭据、公证未通过或签名验证失败时构建会失败。公证通过后，对 DMG 和从中提取的 `.app` 分别装订票据，再生成便携 ZIP。

## 验证范围

```bash
npm run test:packaging
npm run test:mac-package -- dist/mac-arm64/CMBDevClaw.app --bundle-only
```

打包回归检查覆盖 helper 权限修复、原生模块加载路径、缺失或错误架构产物失败，以及 Windows/Linux 打包后处理。CI 对 DMG 和 ZIP 都执行 `--bundle-only` 检查：验证签名、ARM64 架构、执行权限、资源完整性，并使用包内 Electron 实际执行 ripgrep、esbuild、QuickJS/WASM 和 PTY host。

`scripts/smoke-macos-package.mjs` 是包内运行验证脚本，不是独立的构建环境。省略 `--bundle-only` 还可手动启动窗口，验证 preload 和终端 IPC；该检查使用临时用户目录、代理配置和假的 Claude CLI。

macOS 的 PTY host 从 `app.asar.unpacked` 启动时，通过 `createRequire` 从 `app.asar` 解析 `node-pty`，避免上游 helper 路径产生重复的 `.unpacked`。打包钩子在签名前修复 helper 执行权限。

包内检查保留当前分支的 Mods、skills、设计系统、设计模板和宠物资源。当前主机上的验证不能替代最低 macOS 13 系统的实机兼容性验证。
