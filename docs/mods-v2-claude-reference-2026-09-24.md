# Claude Mods 官方参考复核 — 2026-09-24

本次从官方标签获取 [v2.1.280](https://github.com/anthropics/claude-code/releases/tag/v2.1.280)，提交 `56f36532530f88b572854538d685fcf781141e8c`；没有安装或执行新的全局 CLI，没有修改 UAT 工作树。

[Mods 声明](https://github.com/anthropics/claude-code/blob/v2.1.280/mods/types/claude-code.d.ts)与此前 v2.1.278 逐字节相同，共499059字节，SHA-256 `AC107A37C08AD46F8632EDC1639B13A740FAE0B8249A2245532ADFD325E57D0D`，文件头仍为2.1.277。因此已有事件、SDK、Client和UI类型对照继续适用；这只证明公开声明未变化，不证明二进制行为完全一致。

[Mods README](https://github.com/anthropics/claude-code/blob/v2.1.280/mods/README.md)仅有一处差异：内建 telemetry 的调用范围明确限于内建插件，拒绝安装插件，发送采用批量方式。README SHA-256 `A482F39BC7686EB1857976CDE915EC0A2751A1F7469991AE8E97C5B603A617AE`。

本工程没有将第一方分析上报器提供给 Function Mods。自定义 engine noun 的名称不表示拥有该上报器，也不代表上游 telemetry 兼容；以后如接入必须单独建立真实宿主授权边界，不能凭 plugin name 或 guest 提供字段提升身份。

实施方向保持：本工程原有 Agent/权限/租约/完成循环上的通用能力，真实 guest/session 与桌面 Client 的验证，随后用 Autobiz 作为真实业务示例。兼容矩阵状态没有因版本号提升而升级。v2.1.273的历史 upstream runtime 测试范围仍单独保留，不描述成v2.1.280二进制已验证。

原始下载、差异和指纹保存在本地忽略目录 `output/mods-v2-validation/2026-09-24-claude-v280-audit/`。本次 GitHub API 遇到限流，改用公开 Git 标签解析及 raw 标签固定文件交叉检查；未依赖非官方摘要。
