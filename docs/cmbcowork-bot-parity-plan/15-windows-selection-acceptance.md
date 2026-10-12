# Windows 文本全选实机验收

本项验证生产 Worker 的 `select_all_text`，复用原 UIA provider、人工审批、效果收据和 WGC。测试控件必须实际同时提供 ValuePattern、TextPattern 与完整文本选择能力；不支持会失败，不会跳过。COM 部分只证明反复观察/清理/重新获取后的可用性，不把内存变化或 ACK 当作原生引用计数。

## CI

`.github/workflows/ci.yml` 在原 compiled Shell gate（含五项 Windows 内核断言）成功后串行构建测试控件并执行 `tests/run-bot-windows-native-selection.mjs`。复用现有 SDK **10.0.401** 和已初始化的隔离 home；fixture 源、lock、obj 与发布物均放 `RUNNER_TEMP`。restore 使用 `--locked-mode`，publish 保留原严格分析器与 warnings-as-errors，不更新原生发行 manifest。

失败 artifact 只新增 `cmb-windows-selection-report-*/summary.json`：成功标记、真实结果计数（拿不到为 null）、退出码和 fixture SHA256。原始 Vitest JSON、控制库、proof 文件、secret store 和完整隔离 home 不上传。每个现有用例的时限与原五项断言保持原状。

## 手工运行（真实 Windows x64）

前提：Node 符合仓库 `.nvmrc`、依赖与当前 app/原生包已构建，SDK 10.0.401；先通过应用设置**显式初始化单独的验收 home**，停止该 home 的桌面 app/Host 后再运行。不要指向日常使用的 home，不要伪造 `GITHUB_ACTIONS` 来调用 CI 初始化脚本。验收使用本地受控 SSE，不需要外部模型密钥。

在仓库根目录 PowerShell 中设置已有受信构建的包路径与独立 manifest pin：

```powershell
$env:CMB_COWORK_AGENT_HOME = '<已经单独初始化的绝对 home 路径>'
$env:CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY = Join-Path $env:CMB_COWORK_AGENT_HOME 'bot-host'
$env:CMB_BOT_NATIVE_SANDBOX_DIRECTORY = '<该构建已封装的 win32-x64 原生包绝对路径>'
$env:CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 = '<独立构建产出的 64 位小写 SHA256 pin>'
$env:CMB_BOT_NATIVE_WINDOWS_TEST = '1'
node tests/run-bot-windows-native.mjs
if ($LASTEXITCODE -ne 0) { throw '原五项内核验收未通过' }

$fixtureRoot = Join-Path $env:TEMP ('cmb-windows-selection-fixture-' + [guid]::NewGuid())
$source = Join-Path $fixtureRoot 'source'
$artifacts = Join-Path $fixtureRoot 'artifacts'
$publish = Join-Path $fixtureRoot 'publish'
New-Item -ItemType Directory -Path $source | Out-Null
foreach ($name in @('CMB.NativeSelectionFixture.csproj', 'Program.cs', 'packages.lock.json')) {
  Copy-Item -LiteralPath (Join-Path 'tests/windows-native-selection-fixture' $name) -Destination $source
}
$project = Join-Path $source 'CMB.NativeSelectionFixture.csproj'
if ((dotnet --version).Trim() -ne '10.0.401') { throw '需要固定 SDK 10.0.401' }
dotnet restore $project --locked-mode --artifacts-path $artifacts --runtime win-x64 --property:Configuration=Release --disable-build-servers
if ($LASTEXITCODE -ne 0) { throw 'Locked restore failed' }
dotnet publish $project --no-restore --artifacts-path $artifacts --output $publish --configuration Release --runtime win-x64 --disable-build-servers --property:UseSharedCompilation=false
if ($LASTEXITCODE -ne 0) { throw 'Strict publish failed' }
$env:CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE = node --input-type=module -e 'import { realpath } from "node:fs/promises"; console.log(await realpath(process.argv[1]))' (Join-Path $publish 'CMBDevClaw.NativeSelectionFixture.exe')
if ($LASTEXITCODE -ne 0) { throw 'Fixture canonical path failed' }
$env:CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE_SHA256 = (Get-FileHash -LiteralPath $env:CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE -Algorithm SHA256).Hash.ToLowerInvariant()
node tests/run-bot-windows-native-selection.mjs
if ($LASTEXITCODE -ne 0) { throw '实机选择验收未通过，保留现场核对' }
```

这里的路径必须是原准备 home 和其匹配的、物理存在的受信构建；测试会核对 native setup marker、编译摘要、真实 Job、HWND/进程身份和 fixture SHA。未知结果不重放，失败后保持原现场供本机核对。发布 SDK 成功、macOS 跨编译或 TS mock 均不能记为 Windows 实机通过。
