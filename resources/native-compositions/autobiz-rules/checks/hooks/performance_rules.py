"""Read-only rules extracted from hooks/performance_checker.py. See provenance.json."""
from __future__ import annotations
import re
from typing import List, Dict, Tuple

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


FRONTEND_EXTENSIONS = {'.js', '.jsx', '.ts', '.tsx', '.vue', '.mjs', '.cjs'}
