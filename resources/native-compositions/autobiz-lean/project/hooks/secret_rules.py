"""Read-only rules extracted from hooks/check-secrets-new.py. See provenance.json."""
from __future__ import annotations
import re

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
