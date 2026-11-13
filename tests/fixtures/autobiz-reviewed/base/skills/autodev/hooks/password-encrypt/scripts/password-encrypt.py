#!/usr/bin/env python3
"""
password-encrypt.py - 密码加密工具
调用内部 API 将明文密码加密为 BEE_ENC_COMMON_ 格式
"""

import sys
import json
import urllib.request
import urllib.error

API_URL = "http://aicodecheck.paasst.cmbchina.cn/services/ai-tool/password-encrypt"


def encrypt_passwords(passwords: list) -> list:
    """
    调用加密 API
    
    Args:
        passwords: 明文密码列表
        
    Returns:
        加密后的密码列表
    """
    if not passwords:
        return []
    
    payload = json.dumps({"rawPasswd": passwords}).encode('utf-8')
    
    headers = {
        "Content-Type": "application/json"
    }
    
    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers=headers,
        method='POST'
    )
    
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode('utf-8'))
            
            if data.get('success'):
                return data['result'].get('encryptedPasswd', [])
            else:
                error_msg = data.get('message', '未知错误')
                error_code = data.get('errorCode', 'UNKNOWN')
                raise Exception(f"{error_msg} (code: {error_code})")
                
    except urllib.error.URLError as e:
        raise Exception(f"API 调用失败: {e}")
    except json.JSONDecodeError as e:
        raise Exception(f"响应解析失败: {e}")


def parse_input(input_str: str) -> list:
    """
    解析输入，提取密码列表
    
    支持格式：
    - JSON: {"rawPasswd": ["pass1", "pass2"]}
    - 数组: ["pass1", "pass2"]
    - 单行: pass1
    """
    input_str = input_str.strip()
    
    if not input_str:
        return []
    
    # 尝试解析为 JSON
    try:
        data = json.loads(input_str)
        
        # 如果是 {"rawPasswd": [...]} 格式
        if isinstance(data, dict) and 'rawPasswd' in data:
            return data['rawPasswd']
        
        # 如果是数组格式
        if isinstance(data, list):
            return data
            
        # 如果是单个字符串
        if isinstance(data, str):
            return [data]
            
    except json.JSONDecodeError:
        pass
    
    # 纯文本，按行分割
    lines = [line.strip() for line in input_str.split('\n') if line.strip()]
    return lines if lines else [input_str]


def main():
    # 读取输入
    if len(sys.argv) > 1:
        input_str = sys.argv[1]
    else:
        input_str = sys.stdin.read()
    
    # 解析密码列表
    passwords = parse_input(input_str)
    
    if not passwords:
        print("错误: 没有提供密码", file=sys.stderr)
        print("用法: echo 'password' | password-encrypt.py", file=sys.stderr)
        print("   或: password-encrypt.py '{\"rawPasswd\": [\"password\"]}'", file=sys.stderr)
        sys.exit(1)
    
    try:
        # 调用加密
        encrypted = encrypt_passwords(passwords)
        
        # 输出结果
        for pwd in encrypted:
            print(pwd)
            
    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
