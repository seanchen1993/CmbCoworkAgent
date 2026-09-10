# 本地日志敏感信息脱敏

应用在统一日志出口执行脱敏，业务代码直接调用 `console.log/info/warn/error/debug/trace` 时，也不会把已识别的敏感值原样写入本地日志。

## 覆盖范围

- 主进程终端输出、`logs/main.log`，以及转发到调试面板的主进程日志。
- 渲染进程写入的 `logs/renderer.log`。
- Hook 日志在 UI 中的诊断记录和 `hooks/log/hooks.<日期>.jsonl`。
- 升级后首次启动会原地脱敏上述历史日志及轮转文件，并把类 Unix 系统上的日志目录/文件权限收紧为 `0700` / `0600`。

## 默认规则

| 类型 | 输出示例 |
| --- | --- |
| 中国大陆身份证号（18 位） | `110101********123X` |
| 中国大陆手机号 | `138****8000` |
| 邮箱 | `z*******@example.com` |
| 银行卡号（通过 Luhn 校验） | `622202******7894` |
| Password、Token、Authorization、Cookie、私钥等凭据 | `[REDACTED]` |

规则同时处理字符串和嵌套对象。对象字段名如 `idCard`、`contactPhone`、`bankCardNo`、`password`、`accessToken` 会触发对应策略；循环引用和 `Error` 对象也会先复制、脱敏后再输出，不修改业务对象本身。

## 边界

脱敏是日志的纵深防护，不应替代“不要记录秘密”的编码约束。姓名、自然语言地址、业务自定义账号等没有稳定格式的内容无法仅靠通用规则可靠识别；新增明确的敏感字段时，应同步扩展 `src/main/log-redaction.ts` 的字段分类和测试。Trace 使用独立的本地加密机制，见 [Trace 本地存储安全](trace-local-storage-security.md)。
