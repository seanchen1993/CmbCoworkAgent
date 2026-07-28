# Trace 本地存储安全

## 为什么不能继续明文 JSONL

一条完整 Trace 会包含用户消息、模型输入与输出、工具参数与结果、节点输入输出，以及用户和组织归属字段。即使文件只保存在本机，终端安全软件或 DLP 扫描器也能直接从明文 JSONL 中命中账号、令牌、内部地址、代码和业务数据。原有云端上报 `sanitizer` 只负责截断与控制体积，不等同于本地敏感信息脱敏。

## 默认机制

`CMB_COWORK_TRACE_STORAGE_MODE` 未配置时使用 `encrypted`：

1. 每条 Trace 先序列化，再用随机 IV 的 AES-256-GCM 加密；认证标签可检测文件篡改。
2. AES 数据密钥由 Electron `safeStorage` 封装，并保存为 `traces/.trace-key-v1.json`。Windows 使用 DPAPI，macOS 使用 Keychain，Linux 必须使用可用的 Secret Store。
3. JSONL 文件只保留加密信封，不再包含可扫描的消息、工具结果或身份字段明文。
4. `traces/` 和线程目录在类 Unix 系统上收紧为 `0700`，密钥与 JSONL 文件收紧为 `0600`。
5. 启动时自动把已有明文 `.jsonl` 原地迁移为加密信封；读取、回放、优化器和删除接口同时兼容新旧格式。
6. 每个线程仍最多保留 50 个 Trace，超出后删除最旧文件。

加密不可用时采用 fail-closed：Agent 主流程继续运行，但不把新 Trace 降级写成明文。Linux 如果 Electron 只能选择不安全的 `basic_text` 后端，也会视为加密不可用。主进程日志会给出明确告警。

## 配置

| 值          | 行为                                                 | 使用场景                      |
| ----------- | ---------------------------------------------------- | ----------------------------- |
| `encrypted` | 默认；加密新 Trace，并迁移历史明文                   | 生产、内网、真实研发数据      |
| `off`       | 停止新增本地 Trace；若安全存储可用，仍会加密历史明文 | 禁止本地留存 Trace 的严格环境 |
| `plaintext` | 明文写入，不迁移历史文件                             | 仅限隔离目录中的合成测试数据  |

示例：

```bash
CMB_COWORK_TRACE_STORAGE_MODE=off
```

`plaintext` 是显式的不安全逃生口。外部评测如果必须直接解析 JSONL，应同时设置独立的 `CMB_COWORK_AGENT_HOME` / `CMB_COWORK_TRACES_DIR`，并确保输入不含真实用户或内部数据。

## 升级与排查

- 从旧版本升级后，正常启动一次应用即可迁移 `~/.cmbcoworkagent/traces` 下的历史明文；日志会报告成功、已加密和失败文件数。
- 如果日志提示 safeStorage 不可用，新 Trace 不会落盘。应先修复系统 Keychain/DPAPI/Secret Store，或在不需要 Trace 时设为 `off`，不要切到 `plaintext` 绕过。
- safeStorage 不可用时，应用不会擅自删除无法迁移的旧明文；需要按本单位的数据保留流程清理旧 `traces/` 目录，并保持 `off`，或先恢复安全存储后再启动迁移。
- `.trace-key-v1.json` 与加密 JSONL 必须一起备份。删除密钥文件后，已有 Trace 无法恢复。
- 独立 Node.js 脚本无法直接解密默认存储；应通过应用内读取接口消费 Trace。

该机制解决的是 `traces/` 静态文件的明文暴露和安全扫描命中问题。它不防护已经控制当前登录用户会话的恶意进程，也不隐藏应用在用户主动查看 Trace 时展示的内容。日志使用独立的[敏感信息脱敏机制](log-redaction-security.md)；线程数据库、LangGraph checkpoint 和 Memory 仍属于其他存储面，需要按各自的数据分级与留存策略单独治理。
