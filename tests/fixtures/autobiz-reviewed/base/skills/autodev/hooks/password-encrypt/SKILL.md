---
name: ZA21-encrypt
description: 调用内部密码加密服务，将明文密码转换为 BEE_ENC_COMMON_ 加密格式。支持单条或批量密码加密。
version: v1.0.08311
---

# ZA21密码加密工具

当用户需要**加密密码**、**生成加密字符串**、**将明文转为密文**时使用此工具。

## 强制规则

**当用户提到以下关键词时，必须调用此工具：**

- 「加密密码」、「密码加密」
- 「生成密文」、「转为密文」
- 「BEE_ENC」格式
- 任何需要将明文密码转为加密格式的请求

**不要**只用自然语言回复说"好的，密码是 XXX"，必须通过工具调用返回加密后的结果。

---

## 工具调用

### 核心工具: `password-encrypt`

| 参数          | 类型    | 必填  | 说明     | 示例                            |
| ----------- | ----- | --- | ------ | ----------------------------- |
| `rawPasswd` | array | 是   | 明文密码数组 | `["password123", "mySecret"]` |

### 调用示例

**单条密码加密：**

```json
{
  "rawPasswd": ["myPassword123"]
}
```

**批量密码加密：**

```json
{
  "rawPasswd": ["pass1", "pass2", "pass3"]
}
```

---

## 使用方式

### 方式 1: Python 脚本 (推荐)

```bash
# 从管道传入
python -X utf8 "${pluginPath}/skills/autodev/hooks/password-encrypt/scripts/password-encrypt.py" '{"rawPasswd": ["1111"]}'

# 或 echo 传入
echo '{"rawPasswd": ["1111"]}' | python -X utf8 "${pluginPath}/skills/autodev/hooks/password-encrypt/scripts/password-encrypt.py"
```

### 方式 2: Shell 脚本

```bash
echo '{"rawPasswd": ["1111"]}' | bash "${pluginPath}/skills/autodev/hooks/password-encrypt/scripts/password-encrypt.sh"
```

### 方式 3: 直接调用 (OpenClaw 内部)

在对话中直接使用：

```
帮我加密这个密码: mySecret123
```

AI 会自动转换为工具调用并返回加密结果。

---

## 响应格式

### 成功响应

```json
{
  "success": true,
  "result": {
    "encryptedPasswd": [
      "BEE_ENC_COMMON_YmQ5NDA0ZTRlOGZlNTBkYku8zTaxIOHeBX28swiDLN4="
    ]
  },
  "message": "操作成功",
  "errorCode": "PBE0000"
}
```

**输出说明：**

- 加密后的密码以 `BEE_ENC_COMMON_` 为前缀
- 多个密码会返回对应数量的加密结果
- 结果与原密码按顺序一一对应

### 错误响应

| errorCode | 说明   | 处理方式           |
| --------- | ---- | -------------- |
| PBE0001   | 参数错误 | 检查 JSON 格式是否正确 |
| PBE0002   | 服务异常 | 稍后重试或联系管理员     |
| PBE0003   | 网络超时 | 检查网络连接后重试      |

---

## AI 决策指南

| 用户请求             | 操作     | rawPasswd 格式      |
| ---------------- | ------ | ----------------- |
| "帮我加密密码 XXX"     | 调用工具   | `["XXX"]`         |
| "加密这些密码 A, B, C" | 调用工具   | `["A", "B", "C"]` |
| "转为密文"           | 追问密码内容 | —                 |
| "生成 BEE_ENC 格式"  | 调用工具   | 用户提供的内容           |

---

## 回复模板

- **单条成功**：`🔐 加密完成：BEE_ENC_COMMON_xxx`
- **批量成功**：`🔐 已加密 {N} 个密码：\n1. BEE_ENC_COMMON_xxx\n2. BEE_ENC_COMMON_yyy`
- **失败**：`❌ 加密失败：{错误信息}`

---

## 安全提示

⚠️ 此工具处理敏感信息：

- 不要在日志中记录明文密码
- 仅在受信任的环境中使用
- 加密后的密码格式为 `BEE_ENC_COMMON_`

---

## 脚本位置

| 脚本        | 路径                            | 说明            |
| --------- | ----------------------------- | ------------- |
| Python 版本 | `${pluginPath}/skills/autodev/hooks/password-encrypt/scripts/password-encrypt.py` | 推荐，功能完整       |
| Shell 版本  | `${pluginPath}/skills/autodev/hooks/password-encrypt/scripts/password-encrypt.sh` | 备用，依赖 curl/jq |

---

## 安装到系统 PATH

```bash
# 创建软链（推荐 Python 版本）
ln -s /root/.openclaw/workspace/skills/password-encrypt/scripts/password-encrypt.py /usr/local/bin/password-encrypt

# 然后可以直接使用
password-encrypt '{"rawPasswd": ["myPassword"]}'
```
