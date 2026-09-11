# 更新日志与正式、灰度更新逻辑

## 日志位置

默认目录为 `%USERPROFILE%\.cmbcoworkagent\updates`（Linux 为
`~/.cmbcoworkagent/updates`）。设置 `CMB_COWORK_AGENT_HOME` 时，使用该目录下的
`updates`。日志保存在应用安装目录之外，替换 ZIP 或回滚应用不会清除这些记录。

| 文件 | 内容 |
| --- | --- |
| `updater.log` | 检查来源、通道选择、包版本和最终版本、平台覆盖、下载/校验/解压、安装前复核、启动自检和回滚原因 |
| `update.launcher.log` / `full-update.launcher.log` | Windows ASAR / ZIP 安装的启动请求、阶段、异常、脚本退出码 |
| `rollback.launcher.log` / `full-rollback.launcher.log` | Windows 回滚脚本的阶段、异常和退出码 |
| `cleanup-backups.launcher.log` | Windows 备份清理脚本输出和退出码 |
| `update.log` / `full-update.log` / `rollback.log` / `full-rollback.log` | Linux 安装或回滚的阶段、失败行号和退出码 |

`updater.log` 同步落盘，避免立即退出/回滚时丢失缓冲区。记录包含 UTC 时间、进程
ID、级别和详情，并复用应用的敏感信息脱敏逻辑。文件达到 5 MiB 时在下一次写入
前轮转为 `.1`。脚本日志按次追加；启动器在下一次启动前也检查 5 MiB 轮转门槛。
轮转失败时仍尝试追加当前记录；文件写入或控制台输出异常不会阻止安装或改变回滚决策。
Linux 脚本记录重启阶段和进程 ID；应用启动后的诊断继续写入 `updater.log` 和应用日志，
避免把长期运行的原始标准输出写入无轮转、无脱敏的更新日志。

Windows 的 `.cmd` 启动器调用 `.launcher.ps1`，由后者捕获 PowerShell 各输出流，
直接以 UTF-8 追加到文件，保留中文路径和错误信息。后台脱离进程时不能依赖
`Write-Host` 到控制台的输出；也不能在 CMD 中同时长期重定向到同一文件，
否则文件句柄会与 PowerShell 的直接写入冲突。
启动器同时记录脚本执行前后的标记，因此即使 PowerShell 语法错误、
无法启动或脚本捕获异常后退出，也有排障记录。脚本的“退出码 0”只代表脚本完成；
必须结合重启后的 `Self-check passed` 确认安装版本生效。

## 1.5.0 ZIP → 1.5.1 ASAR 的排查顺序

1. 找 `Resolved update package`：`packageVersion` 应为 `1.5.0`，
   `targetVersion` 应为 `1.5.1`，`updateType` 应为 `full`。
   `packageSource` 显示使用了 `platform.full` 还是通道的 `full`；
   `declaredPackageVersion` 为 `null`、`packageVersionInherited` 为 `true` 表示
   包版本继承了目标版本。
2. 找 `Install requested`：确认安装时的版本、通道、清单与下载文件对应。
3. 查看 `full-update.launcher.log`（Linux 为 `full-update.log`），确认解压、
   写 marker、目录替换和重启走到了哪一步。
4. 找重启后的 `Startup version comparison`：实际 `currentVersion` 和
   预期 `expectedVersion` 都应为 `1.5.0`，`releaseVersion` 为 `1.5.1`。
5. 若实际 `1.5.0`、预期 `1.5.1`，检查生效的 `full.version` 是否漏填、平台
   覆盖是否仍指向旧配置、下载包内真实版本是否与声明一致。

生效的 `full.version` 必须显式为 `1.5.0`。平台配置优先级高于通道的 `full`，
不会逐字段合并，也不会从 ZIP 文件名推断版本。全局 `minVersion` 不能高于
中间版本；中间版本还必须能通过一次同 major/minor 的 ASAR 更新到最终版本。

旧安装器只在 marker 中写最终版本时，新启动自检会保留符合单调升级条件的
中间 ZIP，等待在线 manifest 验证。这不意味着所有版本不匹配都会被放行：
新 marker 已声明 `releaseVersion` 时，仍严格检查本次实际安装版本。

启动自检运行的是 ZIP 内的代码。要在中间版本启动时获得新增诊断和链式兼容逻辑，
该 ZIP 必须包含相应代码；只更新最终的 1.5.1 ASAR 无法补上此前的启动日志。

## 正式与灰度的差异

这里的正式、灰度指 `stable` / `staging`。`production` / `selftest` 是另一个
维度，只决定读取哪份清单；清单内仍按相同规则选择 stable / staging。

| 环节 | 正式 stable | 灰度 staging |
| --- | --- | --- |
| 候选来源 | 清单顶层 | `staging` 块，版本须高于 stable 和当前客户端 |
| 人群筛选 | 无 | 登录状态、黑白名单、组织、部门、比例、灰度最低版本及过期时间 |
| 强制更新 | 支持 `mandatory` | 永远非强制；顶层 mandatory 会优先选择 stable |
| 包版本与类型 | 共用 `resolveDownload` | 共用 `resolveDownload`；解析失败回退 stable |
| 平台完整包 | 顶层 `platforms[platform].full` 优先于顶层 `full` | `staging.platforms[platform].full` 优先于 `staging.full`，不继承 stable 的包 |
| 下载、SHA256 和解压 | 共用下载器 | 相同 |
| 安装前复核 | 不重新检查通道与包 | 再次检查是否仍为同一灰度包；版本、最终目标、类型、文件、SHA256、大小、rollback 任一变化均撤回；网络失败时允许安装 |
| 实际安装 | 共用 ASAR / ZIP 脚本 | 相同，full marker 记录的 channel 不同 |
| 启动自检与自动回滚 | 检查实际版本是否符合 marker | 同一入口、同一规则，不按灰度身份另行判断 |
| 中间 ZIP 后续跳 | 下次检查继续选择目标 ASAR | 额外保留已开始的灰度链路，退出登录、重新分桶不会中断；撤下/过期灰度、强制 stable、stable 追平以及兼容下限变化仍能中止续跳 |

因此，灰度在**安装前**撤回下载，与安装后因版本不匹配触发的自动回滚，是两个
不同阶段。启动自检发生在窗口和后台更新检查之前，此处没有“灰度专用回滚规则”。

另有一个现存边界：手动回滚在没有本地备份时，读取默认清单的顶层 `rollback`，
没有按 staging、platforms 或 selftest 清单选择远程回滚包。启动自动回滚使用本地
备份，不经过这条路径。本次只补充诊断，不改变通道、包选择和回滚策略。

## 验证范围

回归测试覆盖同步落盘、日志追加与轮转、轮转备份不可替换、控制台输出异常、
异常详情脱敏、日志目录不可写、真实 PowerShell 启动器在后台脱离进程且标准流
被忽略时的成功/异常/语法错误/指定退出码、中文及空格路径、日志写入失败仍执行
脚本、隔离目录内 ZIP 解压失败及成功替换、
ASAR 安装和回滚失败、Bash 成功/失败退出码，以及 stable / staging 的相同启动
自检与回滚行为。测试中的重启被替身接管，不启动或替换用户安装的应用。
