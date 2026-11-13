#!/bin/bash
# password-encrypt.sh - 密码加密工具
# 调用内部 API 将明文密码加密为 BEE_ENC_COMMON_ 格式

set -e

API_URL="http://aicodecheck.paasst.cmbchina.cn/services/ai-tool/password-encrypt"

# 读取输入
if [ -p /dev/stdin ]; then
    # 从管道读取
    INPUT=$(cat)
else
    # 从参数读取
    if [ $# -eq 0 ]; then
        echo "用法: echo '{\"rawPasswd\": [\"password\"]}' | $0" >&2
        echo "   或: $0 '{\"rawPasswd\": [\"password\"]}'" >&2
        exit 1
    fi
    INPUT="$1"
fi

# 如果输入是纯密码字符串（不是JSON），包装成JSON格式
if ! echo "$INPUT" | grep -q "rawPasswd" 2>/dev/null; then
    # 尝试解析为数组格式 ["pass1", "pass2"] 或单个字符串
    if echo "$INPUT" | grep -q '^\s*\['; then
        # 已经是数组格式，提取内容
        PASSWORDS=$(echo "$INPUT" | sed 's/^\s*\[//;s/\]\s*$//')
    else
        # 单个字符串，包装成数组
        PASSWORDS="\"$INPUT\""
    fi
    INPUT="{\"rawPasswd\": [$PASSWORDS]}"
fi

# 调用 API
RESPONSE=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "$INPUT" \
    "$API_URL" 2>/dev/null)

# 检查响应
if [ -z "$RESPONSE" ]; then
    echo '{"error": "API 调用失败，无响应"}' >&2
    exit 1
fi

# 检查是否成功
SUCCESS=$(echo "$RESPONSE" | grep -o '"success"\s*:\s*true' || true)
if [ -z "$SUCCESS" ]; then
    ERROR_CODE=$(echo "$RESPONSE" | grep -o '"errorCode"\s*:\s*"[^"]*"' | cut -d'"' -f4 || echo "UNKNOWN")
    MESSAGE=$(echo "$RESPONSE" | grep -o '"message"\s*:\s*"[^"]*"' | cut -d'"' -f4 || echo "未知错误")
    echo "{\"error\": \"$MESSAGE\", \"code\": \"$ERROR_CODE\"}" >&2
    exit 1
fi

# 输出加密结果
if command -v jq &> /dev/null; then
    # 使用 jq 格式化输出
    echo "$RESPONSE" | jq -r '.result.encryptedPasswd[]'
else
    # 纯文本提取
    echo "$RESPONSE" | grep -o '"encryptedPasswd"\s*:\s*\[[^]]*\]' | \
        sed 's/.*\[//;s/\].*//;s/"//g;s/,/\n/g'
fi
