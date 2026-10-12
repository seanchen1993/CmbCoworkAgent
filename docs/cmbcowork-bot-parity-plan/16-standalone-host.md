# 独立 Bot Host 构建与运行

独立 Host 复用桌面应用的 `host-entry.ts`、运行时、SQLite 和维护进程。桌面与服务构建共用进程入口及构建身份；服务产物不导入 Electron。当前支持 Node.js **22.16 及以上的 22.x**。

## 构建

在仓库已安装锁定依赖后执行：

```sh
npm run build:bot-service -- --out-dir /absolute/new-service-directory
```

输出目录必须尚不存在，父目录必须存在。构建不会替换已有服务目录，也不允许写入源代码、资源、技能或依赖目录。资源与生成文件在构建前后核对；文件数最多 16,384、合计最多 512 MiB，二进制摘要按 64 KiB 分块计算。产物包含工作进程、技能、Mods、原生工具资源和上游许可证。

服务 `package-lock.json` 从仓库锁文件提取实际运行依赖及其完整闭包，保留版本、完整性、嵌套解析和可选平台依赖。`segment` 使用动态 `createRequire`，Mods 也在运行时调用 `esbuild`；两者已显式纳入。构建不会携带开发依赖或用户模型、凭据及 Bot 数据。

## 安装与启动

```sh
cd /absolute/new-service-directory
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node run-host.cjs --data-dir /absolute/private-bot-data
```

启动器先核对运行时和产物清单，然后在同一进程加载 Host。清单用于发现损坏或版本混装，不替代镜像签名和部署环境的写保护。Node 版本不符或产物改变时，在创建数据目录前停止。

模型仍使用现有用户配置和私有模型快照；构建命令不会配置模型。执行资源路径须指向本服务的 `out/resources`，授权工作目录须在运行环境中存在。桌面机器的绝对路径、浏览器和凭据不能直接搬到 Linux 容器。

## Kubernetes 扩展边界

每个 Host 使用独立数据目录、身份和生命周期锁；持久卷应覆盖完整 Bot 数据目录，不能仅持久化 `bots.sqlite`。当前认证通道仍为本机 Unix socket / Windows named pipe，未开放网络 RPC。远程网关、身份映射、Linux 原生进程隔离、浏览器运行依赖和外部凭据提供方需按原方案继续接入与验收。

macOS 桌面应用的 Keychain 由 Electron 提供。纯 Node macOS 服务不能将该桌面保护能力当作已可用；Linux 的外部凭据提供方也需明确配置。Windows / Linux 原生沙箱和 Kubernetes 部署不因独立构建通过而记为验收完成。

## 演示文稿运行依赖

演示文稿生成使用锁定的 PptxGenJS 4.0.1（MIT），预览复用现有 `@napi-rs/canvas` 和文档工作进程。安装产物须包含锁文件中的完整依赖。文档任务共享最多 4 个活动工作进程、单任务 15 秒期限和 256 MiB V8 堆限制；堆限制不等于进程 RSS 上限。

macOS、Windows 使用已安装字体。Linux/Kubernetes 运行镜像需要保留中文及拉丁字体，例如 Debian 的 `fonts-noto-cjk` 和 `fonts-dejavu-core`；应用不会在运行时下载字体。保存布局记录所用字体，跨机器缺少该字体时预览明确报错，原 PPTX 仍可下载。

当前支持可编辑文本与形状、三种版式和逐页预览。预览由保存布局绘制，不是 Office 渲染截图，接收端 Office 可能替换字体。上传模板、图表和 Google Slides 编辑不在该生成器已实现范围内；新依赖尚需在各平台安装产物中验证。

## 验证

```sh
npm run test:bot:service
```

测试构建独立产物、在独立目录新安装运行依赖，验证真实认证 Host、SQLite 创建收据、桌面连接断开后继续运行、实际 SIGKILL 后恢复同一身份、修改工作进程后拒绝启动、超大清单拒绝、真实 Mods/esbuild/QuickJS 加载及已有服务目录不被覆盖。开发机的默认 Node 非 22.x 时，可通过 `CMB_BOT_SERVICE_NODE` 指定已安装的 Node 22 可执行文件。

2026-10-05：macOS arm64 / Node 22.23.3 正式入口验收通过（`/tmp/cmb-service-production-smoke4.log`）。首轮缺少动态依赖的失败日志保留在 `/tmp/cmb-service-production-smoke.log`。这不是真实外部模型、Windows / Linux 原生沙箱或 Kubernetes 实机验收。
