#!/usr/bin/env python3
"""
前端性能编码规范检测脚本（Hook 模式）
7 条核心性能规则，每条规则独立为一个检测方法。
用于在 skill hook 中调用。

工作流程：
1. 检查命令行参数是否包含 "code_done"，不包含则静默退出
2. 读取 WORKSPACE_PATH 环境变量获取当前工作区
3. 在工作区执行 git diff --name-only 获取变动文件
4. 过滤出前端文件（.js/.jsx/.ts/.tsx/.vue/.mjs/.cjs）
5. 对每个变动文件执行 7 条性能规则检测
6. 输出 Hook JSON 决策（放行/阻断）

用法（Hook 模式）：
    python performance_checker.py code_done
"""

from __future__ import annotations

import re
import sys
import json
import os
import shlex
from pathlib import Path
from typing import List, Dict, Tuple
from dataclasses import dataclass
from typing import Any
from paths import (
    STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR,
    contains_workspace_argument,
)
# ============================================================
# 规则定义
# ============================================================

RULES: List[Dict] = [
    {
        "id": "FRONT-RULE001",
        "risk": "高风险",
        "category": "性能",
        "title": "定时器中直接触发 API 请求",
        "desc": "禁止在 setInterval / setTimeout / requestAnimationFrame 中直接触发 API 请求或调用浏览器API",
        "check": lambda lines: _check_timer_api(lines),
    },
    {
        "id": "FRONT-RULE002",
        "risk": "高风险",
        "category": "性能",
        "title": "资源使用后未显式清除",
        "desc": "setInterval、setTimeout、addEventListener、WebSocket、URL.createObjectURL、Web Worker、SharedWorker 使用完成后必须显式清除",
        "check": lambda lines: _check_resource_cleanup(lines),
    },
    {
        "id": "FRONT-RULE003",
        "risk": "高风险",
        "category": "性能",
        "title": "循环中注册定时器/事件/WebSocket",
        "desc": "禁止在循环中使用 setInterval、setTimeout、addEventListener、WebSocket 直接触发 API 请求或调用浏览器API",
        "check": lambda lines: _check_loop_registration(lines),
    },
    {
        "id": "FRONT-RULE004",
        "risk": "中风险",
        "category": "性能",
        "title": "高频事件未节流/防抖",
        "desc": "resize、scroll、mousemove 这些 window 事件监听需要防抖或节流",
        "check": lambda lines: _check_throttle_debounce(lines),
    },
    {
        "id": "FRONT-RULE005",
        "risk": "高风险",
        "category": "性能",
        "title": "组件卸载时未清理副作用",
        "desc": "组件卸载时必须清理定时器、事件监听、WebSocket、未完成请求等副作用",
        "check": lambda lines: _check_component_cleanup(lines),
    },
    {
        "id": "FRONT-RULE006",
        "risk": "中风险",
        "category": "性能",
        "title": "轮询缺少退避和可见性感知",
        "desc": "轮询逻辑必须监听页面可见性，不可见时暂停；失败时指数退避",
        "check": lambda lines: _check_polling_backoff(lines),
    },
    {
        "id": "FRONT-RULE007",
        "risk": "中风险",
        "category": "性能",
        "title": "相同参数 API 重复调用",
        "desc": "相同参数的 API 在短时间内重复调用必须做去重或合并",
        "check": lambda lines: _check_duplicate_api(lines),
    },
]

@dataclass(frozen=True)
class CheckpointCommand:
    checkpoint: str
# ============================================================
# 工具函数
# ============================================================

def _find_lines(code: str, pattern: str, flags: int = 0) -> List[Tuple[int, str]]:
    """在代码中搜索匹配的行，返回 (行号, 行内容) 列表"""
    results = []
    for i, line in enumerate(code.splitlines(), 1):
        if re.search(pattern, line, flags):
            results.append((i, line.strip()))
    return results


def _get_line_snippet(lines: str, line_no: int, max_len: int = 120) -> str:
    """获取指定行的代码片段"""
    all_lines = lines.splitlines()
    if 1 <= line_no <= len(all_lines):
        return all_lines[line_no - 1][:max_len]
    return ""


def _is_in_string(line: str, pos: int) -> bool:
    """检查位置 pos 是否在字符串引号内"""
    before = line[:pos]
    single_quotes = 0
    double_quotes = 0
    i = 0
    while i < len(before):
        if before[i] == '\\':
            i += 2
            continue
        if before[i] == "'":
            single_quotes += 1
        elif before[i] == '"':
            double_quotes += 1
        i += 1
    return single_quotes % 2 == 1 or double_quotes % 2 == 1


# ============================================================
# RULE001: 定时器中直接触发 API 请求
# ============================================================

def _check_timer_api(lines: str) -> List[Dict]:
    """
    检测 setInterval/setTimeout/requestAnimationFrame 回调中
    直接调用 fetch/axios/XMLHttpRequest 等 API 请求或浏览器API。
    通过括号匹配精确识别定时器回调边界，避免误报。
    """
    findings = []
    timer_pattern = r'(setInterval|setTimeout|requestAnimationFrame)\s*\('
    api_pattern = r'(fetch\s*\(|axios\.|\.ajax\s*\(|XMLHttpRequest|new\s+Request\s*\()'

    in_timer = False
    timer_start = 0
    timer_code = ""
    paren_depth = 0
    # print(f"WARNING 检测 setInterval/setTimeout/requestAnimationFrame 回调中")
    for i, line in enumerate(lines.splitlines(), 1):
        if not in_timer:
            m = re.search(timer_pattern, line)
            if m:
                in_timer = True
                timer_start = i
                timer_code = line
                paren_depth = line.count('(') - line.count(')')
        else:
            timer_code += "\n" + line
            paren_depth += line.count('(') - line.count(')')

            if paren_depth <= 0:
                clean_code = re.sub(r'//.*', '', timer_code)
                clean_code = re.sub(r'/\*.*?\*/', '', clean_code, flags=re.DOTALL)
                if re.search(api_pattern, clean_code):
                    findings.append({
                        "line": timer_start,
                        "snippet": _get_line_snippet(lines, timer_start),
                        "detail": f"第 {timer_start} 行的定时器回调中直接调用了 API 请求"
                    })
                in_timer = False
                timer_code = ""
                paren_depth = 0

    return findings


# ============================================================
# RULE002: 资源使用后未显式清除
# ============================================================

def _check_resource_cleanup(lines: str) -> List[Dict]:
    """
    检测 setInterval/setTimeout/addEventListener/WebSocket/
    URL.createObjectURL/Web Worker/SharedWorker 使用后是否显式清除。
    排除 React useEffect 中有 return cleanup 的情况。
    每个资源类型独立检测，避免交叉干扰。
    """
    findings = []

    # ---- 2.1 setInterval 未清除 ----
    set_intervals = re.finditer(r'setInterval\s*\(', lines)
    for m in set_intervals:
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        snippet = _get_line_snippet(lines, line_no)
        if _is_in_string(snippet, snippet.find('setInterval')):
            continue
        before = lines[max(0, pos - 500):pos]
        if re.search(r'useEffect\s*\(', before):
            after = lines[pos:pos + 500]
            if re.search(r'return\s+.*clearInterval', after):
                continue
        # 检查同一行或后续 2000 字符内是否有 clearInterval
        after = lines[pos:pos + 2000]
        if re.search(r'clearInterval\s*\(', after):
            continue
        findings.append({
            "line": line_no,
            "snippet": snippet,
            "detail": f"第 {line_no} 行使用了 setInterval，但未找到对应的 clearInterval 清除"
        })

    # ---- 2.2 setTimeout 未清除（仅当赋值给变量时） ----
    timeout_vars = re.finditer(r'(?:const|let|var)\s+(\w+)\s*=\s*setTimeout\s*\(', lines)
    for m in timeout_vars:
        var_name = m.group(1)
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        after = lines[pos:pos + 2000]
        if not re.search(r'clearTimeout\s*\(\s*' + re.escape(var_name) + r'\s*\)', after):
            snippet = _get_line_snippet(lines, line_no)
            findings.append({
                "line": line_no,
                "snippet": snippet,
                "detail": f"第 {line_no} 行的 setTimeout 赋值给变量 '{var_name}'，但未找到对应的 clearTimeout 清除"
            })

    # ---- 2.3 addEventListener 未移除 ----
    add_listeners = re.finditer(r'(?:document|window|element|el|\w+)\s*\.\s*addEventListener\s*\(', lines)
    for m in add_listeners:
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        after = lines[m.end():m.end() + 100]
        event_match = re.search(r'["\'](\w+)["\']', after)
        event_type = event_match.group(1) if event_match else "?"
        before = lines[max(0, pos - 500):pos]
        if re.search(r'useEffect\s*\(', before):
            after_block = lines[pos:pos + 500]
            if re.search(r'return\s+.*removeEventListener', after_block):
                continue
        after_file = lines[pos:pos + 2000]
        if re.search(r'removeEventListener\s*\(\s*["\']' + re.escape(event_type) + r'["\']', after_file):
            continue
        snippet = _get_line_snippet(lines, line_no)
        findings.append({
            "line": line_no,
            "snippet": snippet,
            "detail": f"第 {line_no} 行注册了 '{event_type}' 事件监听，但未找到对应的 removeEventListener 移除"
        })

    # ---- 2.4 WebSocket 未 close ----
    ws_news = re.finditer(r'new\s+WebSocket\s*\(', lines)
    for m in ws_news:
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        after = lines[pos:pos + 2000]
        if re.search(r'\.close\s*\(\)', after):
            continue
        snippet = _get_line_snippet(lines, line_no)
        findings.append({
            "line": line_no,
            "snippet": snippet,
            "detail": f"第 {line_no} 行创建了 WebSocket，但未找到对应的 .close() 关闭"
        })

    # ---- 2.5 URL.createObjectURL 未 revoke ----
    create_urls = re.finditer(r'URL\.createObjectURL\s*\(', lines)
    for m in create_urls:
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        after = lines[pos:pos + 2000]
        if re.search(r'URL\.revokeObjectURL\s*\(', after):
            continue
        snippet = _get_line_snippet(lines, line_no)
        findings.append({
            "line": line_no,
            "snippet": snippet,
            "detail": f"第 {line_no} 行使用了 URL.createObjectURL，但未找到对应的 URL.revokeObjectURL 释放"
        })

    # ---- 2.6 Web Worker / SharedWorker 未 terminate ----
    worker_news = re.finditer(r'new\s+(?:Worker|SharedWorker)\s*\(', lines)
    for m in worker_news:
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        after = lines[pos:pos + 2000]
        if re.search(r'\.terminate\s*\(\)', after):
            continue
        snippet = _get_line_snippet(lines, line_no)
        findings.append({
            "line": line_no,
            "snippet": snippet,
            "detail": f"第 {line_no} 行创建了 Worker，但未找到对应的 .terminate() 终止"
        })

    return findings


# ============================================================
# RULE003: 循环中注册定时器/事件/WebSocket
# ============================================================

def _check_loop_registration(lines: str) -> List[Dict]:
    """
    检测在 for/while/forEach/map 等循环结构中
    注册 setInterval/setTimeout/addEventListener/WebSocket。
    通过括号匹配精确识别循环体边界。
    """
    findings = []
    loop_patterns = [
        r'\bfor\s*\(',
        r'\bwhile\s*\(',
        r'\.forEach\s*\(',
        r'\.map\s*\(',
        r'\.reduce\s*\(',
    ]
    resource_patterns = [
        (r'setInterval\s*\(', 'setInterval'),
        (r'setTimeout\s*\(', 'setTimeout'),
        (r'addEventListener\s*\(', 'addEventListener'),
        (r'new\s+WebSocket\s*\(', 'WebSocket'),
        (r'new\s+Worker\s*\(', 'Worker'),
        (r'new\s+SharedWorker\s*\(', 'SharedWorker'),
    ]

    lines_list = lines.splitlines()
    for i, line in enumerate(lines_list, 1):
        in_loop = False
        for lp in loop_patterns:
            if re.search(lp, line):
                in_loop = True
                break

        if not in_loop:
            continue

        brace_start = line.find('{')
        if brace_start == -1:
            for rp, rname in resource_patterns:
                if re.search(rp, line):
                    findings.append({
                        "line": i,
                        "snippet": line.strip()[:120],
                        "detail": f"第 {i} 行的循环中直接注册了 {rname}，可能导致资源泄漏"
                    })
        else:
            brace_depth = line[brace_start:].count('{') - line[brace_start:].count('}')
            loop_body = line[brace_start + 1:] + "\n"
            j = i
            while brace_depth > 0 and j < len(lines_list):
                j += 1
                if j > len(lines_list):
                    break
                loop_body += lines_list[j - 1] + "\n"
                brace_depth += lines_list[j - 1].count('{') - lines_list[j - 1].count('}')

            for rp, rname in resource_patterns:
                if re.search(rp, loop_body):
                    findings.append({
                        "line": i,
                        "snippet": lines_list[i - 1].strip()[:120],
                        "detail": f"第 {i} 行的循环体中注册了 {rname}，可能导致资源泄漏"
                    })
                    break

    return findings


# ============================================================
# RULE004: 高频事件未节流/防抖
# ============================================================

def _check_throttle_debounce(lines: str) -> List[Dict]:
    """
    检测 resize/scroll/mousemove 等高频事件监听
    是否使用了节流或防抖。
    覆盖原生 addEventListener、Vue 模板、React JSX 三种写法。
    """
    findings = []

    high_freq_events = [
        (r'(?:window|document)\s*\.\s*addEventListener\s*\(\s*["\'](?:resize|scroll|mousemove)["\']', "window 事件"),
        (r'@(?:resize|scroll|mousemove)', "Vue 模板事件"),
        (r'on(?:Resize|Scroll|MouseMove)\s*=', "React JSX 事件"),
    ]

    for pat, label in high_freq_events:
        matches = re.finditer(pat, lines)
        for m in matches:
            pos = m.start()
            line_no = lines[:pos].count('\n') + 1
            after = lines[m.end():m.end() + 500]
            if not re.search(r'(debounce|throttle|防抖|节流|_debounce|_throttle)', after):
                snippet = _get_line_snippet(lines, line_no)
                findings.append({
                    "line": line_no,
                    "snippet": snippet,
                    "detail": f"第 {line_no} 行的 {label} 监听未发现节流或防抖处理"
                })

    return findings


# ============================================================
# RULE005: 组件卸载时未清理副作用
# ============================================================

def _check_component_cleanup(lines: str) -> List[Dict]:
    """
    检测 React useEffect / Vue onMounted 中有副作用
    但缺少对应的 cleanup 函数。
    覆盖 React useEffect 和 Vue Composition API 两种框架。
    """
    findings = []

    # ---- 5.1 React useEffect 有副作用但无 cleanup ----
    use_effect_blocks = re.finditer(
        r'useEffect\s*\(\s*\(\s*\)\s*=>\s*\{',
        lines
    )
    for m in use_effect_blocks:
        block_start = m.end()
        line_no = lines[:m.start()].count('\n') + 1

        brace_depth = 1
        pos = block_start
        block = ""
        while brace_depth > 0 and pos < len(lines):
            char = lines[pos]
            if char == '{':
                brace_depth += 1
            elif char == '}':
                brace_depth -= 1
            block += char
            pos += 1

        has_side_effect = bool(re.search(
            r'(setInterval|setTimeout|addEventListener|\.subscribe\s*\(|new\s+WebSocket)',
            block
        ))
        if not has_side_effect:
            continue

        has_cleanup = bool(re.search(
            r'return\s+\(?\s*\(?\s*\)?\s*=>\s*\{',
            block
        )) or bool(re.search(
            r'return\s+\(\)\s*=>',
            block
        )) or bool(re.search(
            r'return\s+\w+\s*;?\s*\}',
            block
        ))

        if not has_cleanup:
            snippet = _get_line_snippet(lines, line_no)
            findings.append({
                "line": line_no,
                "snippet": snippet,
                "detail": f"第 {line_no} 行的 useEffect 有副作用（定时器/事件/订阅）但缺少 cleanup 函数"
            })

    # ---- 5.2 Vue onMounted/onUnmounted 不配对 ----
    on_mounted = _find_lines(lines, r'onMounted\s*\(')
    on_unmounted = _find_lines(lines, r'onUnmounted\s*\(')
    if on_mounted and not on_unmounted:
        for ln, txt in on_mounted:
            findings.append({
                "line": ln,
                "snippet": txt,
                "detail": f"第 {ln} 行使用了 onMounted 但未找到对应的 onUnmounted 清理"
            })

    # ---- 5.3 Vue watchEffect 未停止 ----
    watch_effects = _find_lines(lines, r'watchEffect\s*\(')
    for ln, txt in watch_effects:
        findings.append({
            "line": ln,
            "snippet": txt,
            "detail": f"第 {ln} 行使用了 watchEffect，组件卸载后可能继续执行，建议在 onUnmounted 中停止"
        })

    return findings


# ============================================================
# RULE006: 轮询缺少退避和可见性感知
# ============================================================

def _check_polling_backoff(lines: str) -> List[Dict]:
    """
    检测轮询逻辑是否具备：
    1. 页面可见性感知（visibilitychange）
    2. 指数退避机制
    通过 setInterval 或递归 setTimeout 实现轮询时检查。
    """
    findings = []

    # 检测 setInterval 实现的轮询
    interval_polls = re.finditer(r'setInterval\s*\(', lines)
    for m in interval_polls:
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        after = lines[m.end():m.end() + 500]

        has_visibility = bool(re.search(r'visibilitychange', after))
        has_backoff = bool(re.search(r'(backoff|退避|Math\.min|Math\.pow|\*=\s*2|\*=\s*1\.5|delay\s*\*=|timeout\s*\*=|retryCount|retryDelay|重试次数|重试间隔)', after))

        if not has_visibility or not has_backoff:
            snippet = _get_line_snippet(lines, line_no)
            detail_parts = []
            if not has_visibility:
                detail_parts.append("未监听页面可见性")
            if not has_backoff:
                detail_parts.append("未实现指数退避")
            findings.append({
                "line": line_no,
                "snippet": snippet,
                "detail": f"第 {line_no} 行的轮询逻辑{'、'.join(detail_parts)}"
            })

    # 检测递归 setTimeout 实现的轮询
    timeout_polls = re.finditer(r'function\s+\w+\s*\(\s*\)\s*\{[^}]*setTimeout\s*\(', lines)
    for m in timeout_polls:
        pos = m.start()
        line_no = lines[:pos].count('\n') + 1
        after = lines[m.end():m.end() + 500]

        has_visibility = bool(re.search(r'visibilitychange', after))
        has_backoff = bool(re.search(r'(backoff|退避|Math\.min|Math\.pow|\*=\s*2|\*=\s*1\.5|delay\s*\*=|timeout\s*\*=|retryCount|retryDelay|重试次数|重试间隔)', after))

        if not has_visibility or not has_backoff:
            snippet = _get_line_snippet(lines, line_no)
            detail_parts = []
            if not has_visibility:
                detail_parts.append("未监听页面可见性")
            if not has_backoff:
                detail_parts.append("未实现指数退避")
            findings.append({
                "line": line_no,
                "snippet": snippet,
                "detail": f"第 {line_no} 行的轮询逻辑{'、'.join(detail_parts)}"
            })

    return findings


# ============================================================
# RULE007: 相同参数 API 重复调用
# ============================================================

def _check_duplicate_api(lines: str) -> List[Dict]:
    """
    检测相同 URL 的 API 调用在代码中出现多次。
    覆盖 fetch、axios.get/post/put/delete 等常见调用方式。
    """
    findings = []
    api_calls = re.finditer(r'(?:fetch|axios\.(?:get|post|put|delete|patch))\s*\(\s*["\']([^"\']+)["\']', lines)
    api_map = {}
    for m in api_calls:
        url = m.group(1)
        line_no = lines[:m.start()].count('\n') + 1
        if url not in api_map:
            api_map[url] = []
        api_map[url].append(line_no)

    for url, line_nums in api_map.items():
        if len(line_nums) > 1:
            for ln in line_nums:
                snippet = _get_line_snippet(lines, ln)
                findings.append({
                    "line": ln,
                    "snippet": snippet,
                    "detail": f"第 {ln} 行的 API '{url[:60]}' 被重复调用（共 {len(line_nums)} 次），建议做去重或合并"
                })

    return findings


# ============================================================
# 主入口
# ============================================================

def run_check(code: str) -> List[Dict]:
    """运行所有规则检测，返回结果列表"""
    all_findings = []
    for rule in RULES:
        findings = rule["check"](code)
        for f in findings:
            f["rule_id"] = rule["id"]
            f["risk"] = rule["risk"]
            f["category"] = rule["category"]
            f["title"] = rule["title"]
        all_findings.extend(findings)
    return all_findings


# 前端文件扩展名（性能检测只关注这些文件）
FRONTEND_EXTENSIONS = {'.js', '.jsx', '.ts', '.tsx', '.vue', '.mjs', '.cjs'}


def _get_changed_files(workspace: str) -> List[str]:
    """在 workspace 中执行 git diff，返回变动的前端文件列表"""
    try:
        import subprocess
        result = subprocess.run(
            ['git', 'diff', '--name-only', '--diff-filter=ACMR', '-u'],
            capture_output=True, text=True, cwd=workspace, timeout=30
        )
        if result.returncode != 0:
            print(f"[hook] git diff 失败: {result.stderr.strip()}", file=sys.stderr)
            return []
        files = [f.strip() for f in result.stdout.splitlines() if f.strip()]
        # 只保留前端文件
        frontend_files = []
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in FRONTEND_EXTENSIONS:
                frontend_files.append(f)
        return frontend_files
    except FileNotFoundError:
        print("[hook] git 命令未找到，跳过 git diff", file=sys.stderr)
        return []
    except Exception as e:
        print(f"[hook] git diff 异常: {e}", file=sys.stderr)
        return []

def remove_duplicate_dirs(path):
    parts = path.split(os.sep)
    unique_parts = []
    prev_part = None
    for part in parts:
        if part != prev_part:
            unique_parts.append(part)
            prev_part = part
    return os.sep.join(unique_parts)


def command_words(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def command_variants(command: str) -> list[str]:
    variants = [command]
    tokens = command_words(command)
    for index, token in enumerate(tokens):
        if token in {"-c", "-lc"} and index + 1 < len(tokens):
            variants.append(tokens[index + 1])
    return variants

def option_value(tokens: list[str], *names: str) -> str:
    for index, token in enumerate(tokens):
        for name in names:
            if token == name and index + 1 < len(tokens):
                return tokens[index + 1]
            if token.startswith(name + "="):
                return token.split("=", 1)[1]
    return ""


def has_flag(tokens: list[str], *names: str) -> bool:
    return any(token in names for token in tokens)

def parse_checkpoint_command(command: str) -> CheckpointCommand | None:
    state_scripts = {"update_checkpoint.py"}
    print(f"checkpoint: {command}", file=sys.stderr)
    for variant in command_variants(command):
        tokens = command_words(variant)
        script_names = {Path(token).name for token in tokens}
        
        if script_names & state_scripts and contains_workspace_argument(tokens):
            raise ValueError(STATE_SCRIPTS_WORKSPACE_ARGUMENT_ERROR)
        if "update_checkpoint.py" not in script_names:
            continue

        checkpoint = option_value(tokens, "--checkpoint", "-c")
        # print(f"checkpoint: {checkpoint}", file=sys.stderr)
        if checkpoint != "code_done" or has_flag(tokens, "--dry-run"):
            return None

        return CheckpointCommand(checkpoint=checkpoint)
    return None

def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}

def first_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:
            return " ".join(str(item) for item in value).strip()
    return ""

def extract_command(payload: dict[str, Any]) -> str:
    tool_input = as_dict(payload.get("tool_input") or payload.get("input"))
    return first_text(
        tool_input.get("command"),
        tool_input.get("cmd"),
        tool_input.get("script"),
        payload.get("command"),
        payload.get("cmd"),
    )

def main():
    # ── 参数检查：仅当参数包含 "code_done" 时才继续执行 ──
    raw_input = sys.stdin.read()
    # raw_input = sys.stdin.read()
    if not raw_input.strip():
        return 0
    # try:
    #     payload = json.loads(raw_input)
    # except json.JSONDecodeError as exc:
    #     print(f"raw_input: {raw_input}", file=sys.stderr)
    #     print(f"code_done 编译校验跳过: hook payload JSON 非法: {exc}", file=sys.stderr)
    #     return 0
    # if not isinstance(payload, dict):
    #     return 0
    # command = extract_command(payload)
    # if not command:
    #     return 0

    # try:
    #     checkpoint_command = parse_checkpoint_command(command)
    # except ValueError as exc:
    #     return block(str(exc))

    # if checkpoint_command is None:
    #     return 0

    if 'code_done' not in raw_input or 'update_checkpoint' not in raw_input:
        return 0
    # # ── 读取环境变量中的当前工作区 ──
    workspace = os.environ.get('WORKSPACE_PATH') or os.environ.get('CLAUDE_PROJECT_DIR') or ''
    # print(f"WARNING 目录{workspace}: 不包含 code_done，静默退出")
    if not workspace:
        # print("WARNING WORKSPACE_PATH 环境变量未设置", file=sys.stdout)
        json.dump({
            "decision": "block",
            "reason": "WORKSPACE_PATH 环境变量未设置，无法获取工作区路径"
        }, sys.stdout, ensure_ascii=False)
        sys.exit(0)

    # # ── 获取变动的前端文件 ──
    # # print(f"workspace{workspace}", file=sys.stderr)
    changed_files = _get_changed_files(workspace)
    if not changed_files:
        # 没有变动的前端文件 → 放行
        # json.dump({}, sys.stdout, ensure_ascii=False)
        sys.exit(0)

    # # print(f"[hook] 检测到 {len(changed_files)} 个变动的前端文件:", file=sys.stderr)
    # # for cf in changed_files:
    # #     print(f"[hook]   {cf}", file=sys.stderr)

    # # ── 对每个变动文件执行性能检测 ──
    all_results = []
    for rel_path in changed_files:
        abs_path = remove_duplicate_dirs(os.path.normpath(os.path.join(workspace, rel_path)))#'D:\\autodev\\LF39.18_WE\\wealthTreasureBoxPc\\src\\mm.jsx' #os.path.join(workspace, rel_path)
        # print(f"[hook]   {abs_path}", file=sys.stderr)
        if not os.path.isfile(abs_path):
            continue
        try:
            with open(abs_path, 'r', encoding='utf-8', errors='ignore') as f:
                code = f.read()
        except Exception as e:
            # print(f"[hook] 读取文件失败 {rel_path}: {e}", file=sys.stdout)
            continue

        file_results = run_check(code)
        for r in file_results:
            r["file"] = rel_path
        all_results.extend(file_results)

    # # if use_json:
    # #     # --json 模式：输出原始检测结果 JSON
    # #     print(json.dumps(all_results, ensure_ascii=False, indent=2))
    # #     sys.exit(0)

    if not all_results:
        # 无问题 → 放行
        # json.dump({}, sys.stdout, ensure_ascii=False)
        sys.exit(0)

    # # 有问题 → 阻断，输出 JSON 决策
    summary_lines = []
    for r in all_results:
        risk_tag = "[HIGH]" if r["risk"] == "高风险" else "[MED]"
        summary_lines.append(f"{risk_tag} [{r['rule_id']}] {r['risk']} - {r['title']} ({r['file']}:{r['line']})")

    reason = (
    f"性能检测发现 {len(all_results)} 个问题（涉及 {len(changed_files)} 个变动文件）:\n"
    + "\n".join(summary_lines)
    + "\n请把以上问题展示给用户，修复后重试。不管当前feature，检测出的代码问题全都需要修复。"
    )

    json.dump({
        "decision": "block",
        "reason": reason,
        "systemMessage": "性能检测未通过，把问题展示给用户后重试",
        "additionalContext": reason,
    }, sys.stdout, ensure_ascii=False)
    sys.exit(0)
    # reason = (
    # f"性能检测发现问题:\n"
    # + "\n请把以上问题展示给用户，修复后重试。不管当前feature，检测出的代码问题全都需要修复。"
    # )
    # json.dump({
    #     "decision": "block",
    #     "reason": reason,
    #     "systemMessage": "性能检测未通过，把问题展示给用户后重试",
    #     "additionalContext": reason,
    # }, sys.stdout, ensure_ascii=False)
    # sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(0)
    # reason = (
    # f"性能检测发现问题:\n"
    # + "\n请把以上问题展示给用户，修复后重试。不管当前feature，检测出的代码问题全都需要修复。"
    # )
    # json.dump({
    #     "decision": "block",
    #     "reason": reason,
    #     "systemMessage": "性能检测未通过，把问题展示给用户后重试",
    #     "additionalContext": reason,
    # }, sys.stdout, ensure_ascii=False)
    # sys.exit(0)
