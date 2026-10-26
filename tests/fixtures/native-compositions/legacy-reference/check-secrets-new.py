#!/usr/bin/env python3
import sys
import json
import os
import re
from pathlib import Path


def is_encrypted_value(value: str) -> bool:
    encrypted_prefixes = ['BEE', 'ENC', '{ciph', 'encrypt:', 'M_ENC', 'LSFI_ENV_COMMON', 'http://']
    for prefix in encrypted_prefixes:
        if value.startswith(prefix):
            return True
    return False


def is_variable_reference(value: str) -> bool:
    patterns = [r'^\$\(.*?\)$', r'^\$\{.*?\}$', r'^<.*?>$', r'^@.*?@$']
    for pattern in patterns:
        if re.match(pattern, value):
            return True
    return False


def is_masked_value(value: str) -> bool:
    if len(value) >= 1 and re.sub(r'[*]', '', value) == '':
        return True
    return False


def should_skip_key(key: str) -> bool:
    k = key.lower().strip()
    public_access_keys = ['publickey', 'public-key', 'pubkey', 'public_key', 'appkey', 'access-key', 'accesskey']
    if k in public_access_keys or re.match(r'^public\s+key$', k) or re.match(r'^access\s+key$', k):
        return True
    if k in ['topickey', 'relatedkey', 'related-key', 'binding-routing-key'] or 'relatedkey' in k:
        return True
    if 'poseidon' in k:
        return True
    if k in ['ignoretoken', 'bee.microservice.token']:
        return True
    return False


def check_line(line: str):
    line = line.strip()
    print(f"line: {line}", file=sys.stderr)
    if not line or line.startswith('#'):
        return None
    match = re.match(r'^\s*([^=:]+)\s*[=:]\s*(.*)$', line)
    if not match:
        return None
    full_key = match.group(1).strip()
    value = match.group(2).strip()
    k = full_key.lower().strip()
    v = value.strip()
    if should_skip_key(k):
        return None
    is_target = False
    rule = ""
    if 'zoo_server_passwords' in k or 'zoo.server.passwords' in k:
        is_target = True
        rule = "Zookeeper"
    elif 'sasl.jaas.config' in k:
        is_target = True
        rule = "Kafka"
    elif 'redis' in k and any(k.endswith(suffix) for suffix in ['password', 'auth', 'pass', 'secret']):
        is_target = True
        rule = "Redis"
    elif any(k.endswith(suffix) for suffix in ['password', 'secret', 'pwd', 'key', 'token']):
        is_target = True
        rule = "GENERAL"
    if not is_target:
        return None
    if is_encrypted_value(v):
        return None
    if is_masked_value(v):
        return None
    if is_variable_reference(v):
        return None
    return (True, rule, full_key, value)


def read_input():
    """
    从 stdin 读取并解析工具调用输入
    返回: (parts, file_path) 或 None（表示应跳过）
    """
    try:
        input_json = sys.stdin.read().strip()
        if not input_json:
            return None
        payload = json.loads(input_json)
    except (json.JSONDecodeError, Exception):
        return None

    tool_input = payload.get('tool_input')
    if not tool_input:
        return None

    parts = []
    if tool_input.get('content') is not None:
        parts.append(str(tool_input['content']))
    if tool_input.get('newString') is not None:
        parts.append(str(tool_input['newString']))

    file_path = tool_input.get('filePath', '')
    if not file_path:
        return None

    return parts, file_path


def main():
    result = read_input()
    if result is None:
        sys.exit(0)
    
    parts, file_path = result

    _, ext = os.path.splitext(file_path.lower())
    target_extensions = ['.yaml', '.yml', '.properties']
    if ext not in target_extensions:
        sys.exit(0)

    found_issues = []
    for part in parts:
        for line in part.split('\n'):
            line = line.strip().replace('\r', '').replace('\n', '')
            result = check_line(line)
            if result:
                _, rule, key, value = result
                found_issues.append({
                    'rule': rule,
                    'key': key,
                    'value': value[:50] + '...' if len(value) > 50 else value
                })
                break

    if found_issues:
        issue = found_issues[0]
        print(f"Workspace shell hook blocked this write.调用ZA21-encrypt技能中加密value,再次写入\n  文件: {file_path}\n  规则: {issue['rule']}\n  键: {issue['key']}")
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)